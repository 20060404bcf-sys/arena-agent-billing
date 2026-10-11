// ==UserScript==
// @name         Arena Agent 计费指纹与自动筛选
// @namespace    local.arena.billing
// @version      0.6.6
// @description  有思考立即停止并排除；无思考拿到本轮完整计价即识别模型，账单未齐保留会话。模型名称与等待阶段常驻显示；内嵌计费识别内核、固定目标名单和100条轮换探针，可导出原始费用。
// @match        https://arena.ai/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/20060404bcf-sys/arena-agent-billing/main/arena-agent-billing.user.js
// @downloadURL  https://raw.githubusercontent.com/20060404bcf-sys/arena-agent-billing/main/arena-agent-billing.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ARENA_AGENT_BILLING_USERSCRIPT__) return;
  window.__ARENA_AGENT_BILLING_USERSCRIPT__ = true;
  // __IDENTIFY_BLOCK_BEGIN__（内嵌 kernel + 压缩目录 + 纯函数胶水；这一段整体可被 parity 测试抽出单独求值）
  // KERNEL_HASH=1fe2bbf7849e8ffbad8a74b5ea4efad0d7977999bc15dc0c99593bc24f1a03f1
  // BUNDLE_HASH=6cee163797e57b24f0f86ab215e7bbb461cb935006be45efb6be1b02f21993f6
  // RULE_VERSION=identify-rules-v1
  // 内嵌 kernel 来源：src/identify-core.mjs（42825 字节；仅去掉顶层 export 前缀）
  // 内嵌目录来源：data/arena-models-derived.json（sha256=5c65b3de93e54fe63e8ec82cce600124304f4f946da696aa680988ad35b9f9ec；366 条有价行 + 100 条无价行计数，共 466 行）
/**
 * identify-core.mjs —— 计费反推内核（纯函数 / 零平台依赖 / 可原样内嵌进油猴脚本在浏览器里跑）
 *
 * ── 契约（T2/T4 按此消费，字段名冻结，不许改）────────────────────────────────
 *   quantize10(x)                        -> string        精确量化到 10 位小数（去尾零）
 *   tokensForCost(costStr, priceDec)     -> bigint | null 费用 + 单价 ⇒ 唯一整数 token 数
 *   fitPriceVector({ costs, prices, base, charged, cm, mm, refVersions }) -> result
 *   identifyFromCost({ costJson, catalog, refVersions })                  -> report
 *
 * ── 本文件的三条硬约束 ───────────────────────────────────────────────────────
 *   · 零平台依赖：没有任何 import，不碰 fs / path / process / window，无顶层副作用。
 *     （需要读文件的部分留在 CLI 里，把"已加载的 catalog 数组"作为参数传进来。）
 *   · 金额与单价一律走 BigInt 精确十进制，禁止用浮点做恒等验证。
 *   · 判定规则逐条实现，每条都有对应断言（见 test/run-identify-core-tests.mjs）。
 *
 * ── 判定规则（本卡核心）─────────────────────────────────────────────────────
 *   1. 目录行没有 in/out 价 ⇒ 计入 ignored，**绝不进候选**。
 *   2. 费用为 0 的分项**不提供单价约束**：它既不能说明单价是 0，也不能单独证明 token=0。
 *      只有"单价已知且严格为正 + 费用恰为 0"才能推 n=0；反解路径下 n=0 来自
 *      "反解单价严格为正"这一显式假设（假设写在 boundary 里）。
 *   3. 候选缺某分项价、而该分项观测费用>0 ⇒ **不许直接进 complete**：
 *      只有用 base 参考方程把缺的单价反解出来（全消息同一价、唯一、非负整数 token）
 *      才算通过；反解欠定/不一致/非整数 ⇒ 只能进 unconstrained(MISSING-CACHE-PRICE)。
 *   4. 数组价 ⇒ **价格分支**：同一套分支跑全部消息，"任一分支可行即该分项通过"，
 *      但**绝不为凑命中在不同消息之间混搭分支**。实际用的是哪一支记在 prices 里。
 *   5. 参考方程左侧是 **base**，不是 charged；
 *      charged 只用于验证恒等式 charged = base × costMultiplier × marginMultiplier。
 *   6. 长上下文消息默认**不参与** complete 判定，只计数进 regime 并标 longContextRule=UNKNOWN。
 *
 * ── 诚实边界（随 report 一起给出，见 buildBoundary）──────────────────────────
 *   · 解出的 token 数是 impliedTokens（由候选单价 + 参考方程推导），**不是观测值**。
 *   · 候选集合 ≠ 模型身份已证明；同价 / 同向量 / 整数倍关系只能报候选与 collisions。
 *   · 反解出的 cr/cw 单价是**反解值**，不是目录实测值。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. 常量
// ─────────────────────────────────────────────────────────────────────────────

const COMPONENTS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const CACHE_COMPONENTS = ['cacheRead', 'cacheWrite'];

/** 分项 → /cost 响应里的字段名（真实 schema，已核实）。 */
const COST_FIELD = {
  input: 'inputTokensCostUsd',
  output: 'outputTokensCostUsd',
  cacheRead: 'cacheReadTokensCostUsd',
  cacheWrite: 'cacheWriteTokensCostUsd',
};

const TEN = 10n;
const QUANTUM_DIGITS = 10;
const QUANTUM = TEN ** 10n;              // 量化单位 1e-10 USD
const MAX_BRANCH_COMBOS = 64;            // 数组价分支组合上限
const MAX_ASSIGN_NODES = 4096;           // 单条消息 token 候选枚举上限
const MAX_KNOWN_ASSIGNS = 64;            // 单条消息已定价分项的 token 分配上限
const ONE_HUNDRED = 100n;

/**
 * 参考费率版本表（模型无关：只吃 token 数，不吃模型价）。
 *   base × 1e10 = in·n_in + cw·n_cw + cr·n_cr + out·n_out
 * 版本 id 与系数沿用 recon-chief 的实测标识（ref-10-05/08 / ref-10-01）。
 */
const DEFAULT_REF_VERSIONS = [
  { id: 'ref-10-05/08', in: 2156, cw: 2695, cr: 100, out: 6468 },
  { id: 'ref-10-01', in: 2156, cw: 2695, cr: 200, out: 12000 },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. 精确十进制（BigInt，无浮点）
// ─────────────────────────────────────────────────────────────────────────────

/** 十进制字面量 → { neg, P, k }，值 = ±P / 10^k。支持指数写法（1e-7）。非法即抛。 */
function parseDec(value) {
  const s = String(value).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new Error('identify-core: 非法十进制字面量 ' + JSON.stringify(s));
  }
  const neg = m[1] === '-';
  let P = BigInt((m[2] || '0') + (m[3] || ''));
  let k = (m[3] || '').length;
  const exp = m[4] ? Number(m[4]) : 0;
  if (exp > 0) P *= TEN ** BigInt(exp);
  else if (exp < 0) k += -exp;
  return { neg, P, k };
}

/** 四舍五入到 1e-10（half away from zero），返回 { q: 非负 BigInt, neg }。 */
function roundToQuantum(value) {
  const { neg, P, k } = parseDec(value);
  let q;
  if (k <= QUANTUM_DIGITS) {
    q = P * TEN ** BigInt(QUANTUM_DIGITS - k);
  } else {
    const d = TEN ** BigInt(k - QUANTUM_DIGITS);
    const r = P % d;
    q = P / d + (2n * r >= d ? 1n : 0n);
  }
  return { q, neg: neg && q !== 0n };
}

/** 非负 quanta(1e-10) → 去尾零的十进制字符串。 */
function formatQuanta(q, neg) {
  if (q === 0n) return '0';
  const s = q.toString().padStart(QUANTUM_DIGITS + 1, '0');
  const intPart = s.slice(0, s.length - QUANTUM_DIGITS);
  const frac = s.slice(s.length - QUANTUM_DIGITS).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? intPart + '.' + frac : intPart);
}

/** 有符号 quanta(1e-10)：金额字符串 → BigInt（round half away from zero）。 */
function quanta10(value) {
  const { q, neg } = roundToQuantum(value);
  return neg ? -q : q;
}

/**
 * ★ 冻结导出：精确量化到 10 位小数，返回去尾零的十进制字符串。
 *   quantize10(0.0032133562999999998) === '0.0032133563'
 *   quantize10('0.0031445000000000006') === '0.0031445'
 *   quantize10(0.19999999999999998) === '0.2'
 */
function quantize10(x) {
  const { q, neg } = roundToQuantum(x);
  return formatQuanta(q, neg);
}

/** 非负有理数 num/den → 去尾零十进制字符串（half-up 到 digits 位）。 */
function fractionToDecimal(num, den, digits = QUANTUM_DIGITS) {
  if (den === 0n || num < 0n || den < 0n) throw new Error('identify-core: fractionToDecimal 只接受非负有理数');
  if (num === 0n) return '0';
  const scaled = num * TEN ** BigInt(digits);
  const q = (2n * scaled + den) / (2n * den);
  return formatQuanta(q, false);
}

/** 非负 BigInt 的 gcd。 */
function gcdBig(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 整数原像：费用 + 单价 ⇒ 整数 token 数
// ─────────────────────────────────────────────────────────────────────────────
//
// 与前作 tools/token-preimage.mjs 的 integerPreimage 语义一致：
//   要求 round(p·n/1e6, 10位) == c，即 round(P·n·1e4 / 10^k) == C（都以 1e-10 为单位）
//   等价区间： (2C−1)·10^k ≤ 2·P·n·10^4 < (2C+1)·10^k
//   区间极窄（宽度 ~1e-4/p 个 token），所以最多只需检查 1–2 个整数。

/**
 * 所有满足 quantize10(p·n/1e6) === quantize10(c) 的非负整数 n。
 *   · c 恰为 0 且单价 > 0 ⇒ 返回 [0n]（"零费用 + 已知正价"的唯一走法，规则 2）
 *   · 单价 ≤ 0 / 负费用 ⇒ 返回 []（无解，不是"免费"）
 */
function tokensForCostAll(costStr, priceDec, maxResults = 8) {
  const C = quanta10(costStr);
  const { neg, P, k } = parseDec(priceDec);
  if (neg || P === 0n) return [];        // 单价必须严格为正
  if (C < 0n) return [];                 // 负费用无解
  if (C === 0n) return [0n];             // 单价>0 且费用恰为 0 ⇒ n = 0

  const pow = TEN ** BigInt(k);
  const numLo = (2n * C - 1n) * pow;
  const numHi = (2n * C + 1n) * pow;
  const den = 2n * P * TEN ** 4n;
  const nMin = numLo <= 0n ? 0n : (numLo + den - 1n) / den;
  const nMax = numHi / den;
  if (nMax < nMin) return [];

  const out = [];
  for (let n = nMin; n <= nMax && out.length < maxResults; n++) {
    const a = P * n * TEN ** 4n;
    const q = (2n * a + pow) / (2n * pow);   // round(P·n·1e4 / 10^k)
    if (q === C) out.push(n);
  }
  return out;
}

/**
 * ★ 冻结导出：费用 + 单价 ⇒ 唯一整数 token 数。
 * 无解或多解（区间塌成 >1 个整数）都返回 null —— 不猜。
 * 需要完整候选集合时用 tokensForCostAll()。
 */
function tokensForCost(costStr, priceDec) {
  const ns = tokensForCostAll(costStr, priceDec, 2);
  return ns.length === 1 ? ns[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 参考方程、恒等式、价格向量键
// ─────────────────────────────────────────────────────────────────────────────

/** refVersions 归一化：接受 {id,in,cw,cr,out} / {id,coef:{...}} / {id,coeffs:{...}}。 */
function normalizeRefVersions(list) {
  const src = Array.isArray(list) && list.length ? list : DEFAULT_REF_VERSIONS;
  return src.map((v, i) => {
    const c = v.coef || v.coeffs || v;
    const num = (x) => BigInt(String(x === undefined || x === null ? 0 : x));
    return {
      id: String(v.id === undefined ? 'ref#' + i : v.id),
      coef: {
        input: num(c.input !== undefined ? c.input : c.in),
        output: num(c.output !== undefined ? c.output : c.out),
        cacheRead: num(c.cacheRead !== undefined ? c.cacheRead : c.cr),
        cacheWrite: num(c.cacheWrite !== undefined ? c.cacheWrite : c.cw),
      },
    };
  });
}

/** charged = base × cm × mm（精确十进制判定）。数据不全 ⇒ null（不猜）。 */
function chargedIdentityCheck(baseStr, chargedStr, cm, mm) {
  if (baseStr === null || baseStr === undefined) return null;
  if (chargedStr === null || chargedStr === undefined) return null;
  if (cm === null || cm === undefined || mm === null || mm === undefined) return null;
  const b = quanta10(baseStr);
  const ch = quanta10(chargedStr);
  const a = parseDec(String(cm));
  const c = parseDec(String(mm));
  const den = TEN ** BigInt(a.k + c.k);
  const lhs = ch * den * (a.neg ? -1n : 1n) * (c.neg ? -1n : 1n);
  const rhs = b * a.P * c.P;
  return lhs === rhs;
}

/** 单价标量化：单体数组视作该值；多元素数组 ⇒ null（必须由调用方选分支，不许 String(array)）。 */
function scalarPrice(p) {
  if (p === null || p === undefined) return null;
  if (Array.isArray(p)) {
    const vals = p.filter((x) => x !== null && x !== undefined);
    if (vals.length !== 1) return null;
    return quantize10(vals[0]);
  }
  return quantize10(p);
}

/** 价格向量键：单价 ×100 后拼接（例：0.1/0.5/0.01/0.125 → "10|50|1|12.5"）。未知价记 '?'。 */
function priceVectorKey(prices) {
  return COMPONENTS.map((comp) => {
    const p = scalarPrice(prices ? prices[comp] : null);
    if (p === null) return '?';
    const { q, neg } = roundToQuantum(p);
    return (neg ? '-' : '') + formatQuanta(q * ONE_HUNDRED, false);
  }).join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. fitPriceVector：单条消息 × 一个（完整）价格向量 是否成立
// ─────────────────────────────────────────────────────────────────────────────

function searchAssignment(lists, refV, baseStr) {
  const baseQ = quanta10(baseStr);
  const combo = COMPONENTS.map(() => 0n);
  let nodes = 0;
  const dfs = (i) => {
    if (nodes++ > MAX_ASSIGN_NODES) return null;
    if (i === COMPONENTS.length) {
      let sum = 0n;
      for (let j = 0; j < COMPONENTS.length; j++) sum += refV.coef[COMPONENTS[j]] * combo[j];
      if (baseQ - sum === 0n) {
        const tokens = {};
        for (let j = 0; j < COMPONENTS.length; j++) tokens[COMPONENTS[j]] = combo[j];
        return tokens;
      }
      return null;
    }
    for (const n of lists[i]) {
      combo[i] = n;
      const hit = dfs(i + 1);
      if (hit) return hit;
    }
    return null;
  };
  return dfs(0);
}

/**
 * ★ 冻结导出：把一条消息的观测费用 / base / charged 与**一个完整价格向量**对账。
 *
 * @param {{costs?:object, prices?:object, base?:string|number, charged?:string|number,
 *          cm?:string|number, mm?:string|number, refVersions?:Array}} input
 * @returns {{
 *   ok:boolean, reason:string|null, refVersion:string|null, residual:string|null,
 *   impliedTokens:object|null, chargedIdentity:boolean|null,
 *   missingPrices:string[], unconstrainedComponents:string[], components:object
 * }}
 *   reason ∈ NO-INTEGER-TOKENS（已知价分项无整数解）| MISSING-CACHE-PRICE（缺价且费用>0）
 *          | ARRAY-PRICE-NEEDS-BRANCH（多元素数组价，必须先选分支）
 *          | UNCONSTRAINED-COMPONENT（有分项未观测，参考方程无法核对）| BASE-RESIDUAL（残差≠0）
 */
function fitPriceVector({ costs, prices, base, charged, cm, mm, refVersions } = {}) {
  const versions = normalizeRefVersions(refVersions);
  const cs = costs || {};
  const ps = prices || {};
  const res = {
    ok: false,
    reason: null,
    refVersion: null,
    residual: null,
    impliedTokens: null,
    chargedIdentity: null,
    missingPrices: [],
    unconstrainedComponents: [],
    components: {},
  };
  const lists = {};

  for (const comp of COMPONENTS) {
    const raw = cs[comp];
    const e = { cost: raw === undefined || raw === null ? null : String(raw) };
    res.components[comp] = e;
    if (raw === undefined || raw === null) {
      e.skipped = 'not-observed';
      lists[comp] = null;
      continue;
    }
    const given = ps[comp];
    if (Array.isArray(given) && given.filter((x) => x !== null && x !== undefined).length > 1) {
      e.skipped = 'array-price';
      res.reason = 'ARRAY-PRICE-NEEDS-BRANCH';
      res.chargedIdentity = chargedIdentityCheck(base, charged, cm, mm);
      return res;
    }
    const p = scalarPrice(given);
    if (p === null) {
      e.skipped = 'no-price';
      if (quanta10(String(raw)) === 0n) {
        e.noInfo = true;
        e.assumedZeroTokens = true;
        e.why = '费用为 0 ⇒ 不提供单价约束；此处 n=0 来自"单价>0"假设';
        res.unconstrainedComponents.push(comp);
        lists[comp] = [0n];
      } else {
        res.missingPrices.push(comp);
        lists[comp] = null;
      }
      continue;
    }
    e.price = p;
    const ns = tokensForCostAll(String(raw), p);
    if (!ns.length) {
      e.failed = true;
      res.reason = 'NO-INTEGER-TOKENS';
      res.chargedIdentity = chargedIdentityCheck(base, charged, cm, mm);
      return res;
    }
    e.ns = ns.map((x) => x.toString());
    lists[comp] = ns;
  }

  res.chargedIdentity = chargedIdentityCheck(base, charged, cm, mm);
  if (res.missingPrices.length) { res.reason = 'MISSING-CACHE-PRICE'; return res; }
  if (COMPONENTS.some((c) => lists[c] === null)) { res.reason = 'UNCONSTRAINED-COMPONENT'; return res; }

  const ordered = COMPONENTS.map((c) => lists[c]);
  for (const v of versions) {
    const tokens = searchAssignment(ordered, v, base);
    if (tokens) {
      res.ok = true;
      res.refVersion = v.id;
      res.residual = '0';
      res.impliedTokens = {};
      for (const c of COMPONENTS) res.impliedTokens[c] = tokens[c].toString();
      return res;
    }
  }
  res.reason = 'BASE-RESIDUAL';
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 会话级识别
// ─────────────────────────────────────────────────────────────────────────────

/** 目录行 → 价格分支选项：{ values:[...] } 或 { values:null }（未知价）。 */
function rowPriceOptions(row) {
  const pr = row && row.prices ? row.prices : {
    input: row ? (row.p_in ?? null) : null,
    output: row ? (row.p_out ?? null) : null,
    cacheRead: row ? (row.p_cr ?? null) : null,
    cacheWrite: row ? (row.p_cw ?? null) : null,
  };
  const out = {};
  for (const comp of COMPONENTS) {
    const v = pr ? pr[comp] : null;
    if (v === null || v === undefined) { out[comp] = { values: null }; continue; }
    const list = Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : [v];
    const vals = [];
    for (const x of list) {
      const s = quantize10(x);
      if (!vals.includes(s)) vals.push(s);
    }
    out[comp] = { values: vals.length ? vals : null };
  }
  return out;
}

/** 数组价 ⇒ 固定分支组合（同一套分支跑全部消息，不做跨消息混搭）。 */
function branchCombos(opts) {
  const base = {};
  for (const comp of COMPONENTS) base[comp] = opts[comp].values ? opts[comp].values[0] : null;
  const dims = COMPONENTS.filter((c) => opts[c].values && opts[c].values.length > 1);
  if (!dims.length) return { combos: [base], truncated: false };
  let combos = [base];
  let truncated = false;
  for (const comp of dims) {
    const next = [];
    for (const cb of combos) for (const v of opts[comp].values) next.push({ ...cb, [comp]: v });
    if (next.length > MAX_BRANCH_COMBOS) { combos = next.slice(0, MAX_BRANCH_COMBOS); truncated = true; }
    else combos = next;
  }
  return { combos, truncated };
}

/** /cost 响应 → 消息数组（messages 既支持 {id: obj} 也支持 [obj, ...]）。 */
function extractMessages(costJson) {
  const out = [];
  const raw = costJson ? costJson.messages : null;
  const push = (id, m) => {
    const actual = (m && (m.actual || m.costDetail || m.cost)) || {};
    const costs = {};
    for (const comp of COMPONENTS) {
      const v = actual[COST_FIELD[comp]];
      costs[comp] = v === undefined || v === null ? null : String(v);
    }
    out.push({
      id: String(id),
      costs,
      base: m ? (m.basePriceUsd ?? null) : null,
      charged: m ? (m.totalChargedUsd ?? null) : null,
      cm: m ? (m.costMultiplier ?? null) : null,
      mm: m ? (m.marginMultiplier ?? null) : null,
      isLongContext: actual.isLongContext === true,
      pricingStrategy: m ? (m.pricingStrategy ?? null) : null,
    });
  };
  if (Array.isArray(raw)) raw.forEach((m, i) => push((m && (m.id ?? m.messageId)) || ('#' + i), m));
  else if (raw && typeof raw === 'object') for (const [id, m] of Object.entries(raw)) push(id, m);
  return out;
}

/**
 * 用 base 参考方程 + 全消息同一价向量 + 非负整数 token，反解目录缺失的
 * cacheRead / cacheWrite 单价。
 *
 * 返回 { ok:true, prices, derived, unconstrained } 或 { ok:false, kind, why }
 *   kind = 'falsified'（可在数学上排除该候选）| 'underdetermined'（解不唯一：不能确认也不能排除）
 *          | 'unobserved'（消息缺分项观测，无法核对参考方程）
 *
 * 规则 3 的落点：缺价 + 观测费用>0 时，只有这里反解出**唯一且一致**的单价才放行；
 * 反解欠定 ⇒ underdetermined ⇒ 该候选只能进 unconstrained。
 */
function deriveCachePrices(combo, refV, std) {
  const unknown = CACHE_COMPONENTS.filter((c) => combo[c] === null);
  if (!unknown.length) return { ok: true, prices: {}, derived: {} };

  // 每条消息：已定价分项的 token 候选 + 各分项费用的 quanta
  const per = [];
  for (const m of std) {
    const knownLists = {};
    for (const comp of COMPONENTS) {
      if (combo[comp] === null) continue;
      const c = m.costs[comp];
      if (c === null) { knownLists[comp] = null; continue; }
      const ns = tokensForCostAll(c, combo[comp]);
      if (!ns.length) {
        return { ok: false, kind: 'falsified', why: comp + ' 在 ' + m.id + ' 上无整数 token 解（p=' + combo[comp] + ', c=' + c + '）' };
      }
      knownLists[comp] = ns;
    }
    const C = {};
    let unobserved = false;
    for (const cc of COMPONENTS) {
      const c = m.costs[cc];
      if (c === null) { C[cc] = null; unobserved = true; continue; }
      C[cc] = quanta10(c);
    }
    per.push({ m, knownLists, C, unobserved });
  }
  if (per.some((rec) => rec.unobserved)) {
    return { ok: false, kind: 'unobserved', why: '存在未观测分项，参考方程无法核对' };
  }

  /** 已定价分项的 token 组合枚举（通常是 1 组）。 */
  const enumerateKnown = (rec) => {
    const comps = COMPONENTS.filter((c) => rec.knownLists[c]);
    const out = [];
    const walk = (i, acc) => {
      if (out.length > MAX_KNOWN_ASSIGNS) return;
      if (i === comps.length) { out.push({ ...acc }); return; }
      for (const n of rec.knownLists[comps[i]]) { acc[comps[i]] = n; walk(i + 1, acc); }
    };
    walk(0, {});
    return out;
  };
  /** 参考方程移项后剩下给未知缓存分项的整数 Z。 */
  const remainderOf = (rec, assign) => {
    let Z = quanta10(rec.m.base);
    for (const comp of COMPONENTS) if (assign[comp] !== undefined) Z -= refV.coef[comp] * assign[comp];
    return Z;
  };

  // ── 只缺一个缓存价：base 方程直接定出它的 token 数，再要求全消息同一价 ──
  if (unknown.length === 1) {
    const U = unknown[0];
    const coefU = refV.coef[U];
    if (coefU <= 0n) return { ok: false, kind: 'underdetermined', why: '参考系数 ≤0，该分项无法由 base 约束' };

    const perMsg = [];
    for (const rec of per) {
      const sols = [];
      for (const assign of enumerateKnown(rec)) {
        const Z = remainderOf(rec, assign);
        if (Z < 0n || Z % coefU !== 0n) continue;
        const nU = Z / coefU;
        const Cu = rec.C[U];
        if (Cu === 0n ? nU !== 0n : nU <= 0n) continue;   // 零费用 ⇒ n 必须为 0（单价>0）
        sols.push({ assign, nU, Cu });
      }
      if (!sols.length) {
        return { ok: false, kind: 'falsified', why: 'base 参考方程对 ' + rec.m.id + ' 无可行 token 分配' };
      }
      perMsg.push({ rec, sols });
    }

    const anchorIdx = perMsg.findIndex((e) => e.sols.some((s) => s.Cu > 0n));
    if (anchorIdx < 0) {
      // 该分项在所有非长上下文消息上费用都是 0 ⇒ 单价无约束（规则 2）
      return { ok: true, prices: { [U]: null }, derived: {}, unconstrained: [U] };
    }
    for (const anchor of perMsg[anchorIdx].sols) {
      if (anchor.Cu === 0n) continue;
      let ok = true;
      for (let i = 0; i < perMsg.length && ok; i++) {
        if (i === anchorIdx) continue;
        const { rec, sols } = perMsg[i];
        const hit = sols.some((s) => (rec.C[U] === 0n ? s.nU === 0n : anchor.Cu * s.nU === rec.C[U] * anchor.nU));
        if (!hit) ok = false;
      }
      if (ok) {
        const dec = fractionToDecimal(anchor.Cu, anchor.nU * 10000n);
        return { ok: true, prices: { [U]: dec }, derived: { [U]: dec } };
      }
    }
    return { ok: false, kind: 'falsified', why: '跨消息 ' + U + ' 单价不一致' };
  }

  // ── 两个缓存价都未知：用"全消息共用同一价向量"把 token 数参数化 ──
  //    n_A^(m) = t · (C_A^(m)/g_A)，n_B^(m) = u · (C_B^(m)/g_B)
  //    代入各消息的 base 方程 ⇒ 关于 (t,u) 的线性方程组
  const A = 'cacheWrite';
  const B = 'cacheRead';
  let gA = 0n;
  let gB = 0n;
  for (const rec of per) {
    gA = gcdBig(gA, rec.C[A] ?? 0n);
    gB = gcdBig(gB, rec.C[B] ?? 0n);
  }

  const groups = [];
  for (const rec of per) {
    const assigns = enumerateKnown(rec);
    if (!assigns.length) return { ok: false, kind: 'falsified', why: rec.m.id + ' 无已定价分项的 token 分配' };
    const rows = assigns.map((assign) => {
      const aHat = gA === 0n ? 0n : (rec.C[A] ?? 0n) / gA;
      const bHat = gB === 0n ? 0n : (rec.C[B] ?? 0n) / gB;
      return {
        Z: remainderOf(rec, assign),
        a: refV.coef[A] * aHat,
        b: refV.coef[B] * bHat,
        aHat,
        bHat,
      };
    });
    groups.push({ id: rec.m.id, rows });
  }

  if (gA === 0n && gB === 0n) {
    // 两个缓存分项在所有非长上下文消息上费用都是 0 ⇒ 单价均无约束（规则 2）
    const sat = groups.every((g) => g.rows.some((r) => r.Z === 0n));
    if (!sat) return { ok: false, kind: 'falsified', why: '两缓存分项费用全为 0 但 base 参考方程不成立' };
    return { ok: true, prices: { [A]: null, [B]: null }, derived: {}, unconstrained: [A, B] };
  }

  let t = null;
  let u = null;
  outer:
  for (let gi = 0; gi < groups.length; gi++) {
    for (let gj = gi + 1; gj < groups.length; gj++) {
      for (const ri of groups[gi].rows) {
        for (const rj of groups[gj].rows) {
          const D = ri.a * rj.b - rj.a * ri.b;
          if (D === 0n) continue;
          const tNum = ri.Z * rj.b - rj.Z * ri.b;
          const uNum = ri.a * rj.Z - rj.a * ri.Z;
          if (tNum % D !== 0n || uNum % D !== 0n) continue;
          const tt = tNum / D;
          const uu = uNum / D;
          if (tt < 0n || uu < 0n) continue;
          if (!groups.every((g) => g.rows.some((r) => r.a * tt + r.b * uu === r.Z))) continue;
          t = tt;
          u = uu;
          break outer;
        }
      }
    }
  }

  if (t === null) {
    // 秩 ≤ 1 或解不可行：区分"可排除"与"欠定（不能确认也不能排除）"
    const flat = groups.flatMap((g) => g.rows);
    const ref = flat.find((r) => r.a !== 0n || r.b !== 0n);
    if (!ref) return { ok: false, kind: 'falsified', why: '参考方程与观测不符（两缓存分项系数全为 0）' };
    const consistent = flat.every((r) => r.a * ref.b === ref.a * r.b && r.a * ref.Z === ref.a * r.Z && r.b * ref.Z === ref.b * r.Z);
    if (!consistent) return { ok: false, kind: 'falsified', why: 'base 参考方程在消息之间不自洽' };
    if (ref.Z < 0n) return { ok: false, kind: 'falsified', why: 'base 参考方程无非负解' };
    return { ok: false, kind: 'underdetermined', why: '两个缓存价同时缺失且方程秩不足 ⇒ 单价不唯一' };
  }

  const priceOf = (comp, scale, g) => {
    if (g === 0n || scale === 0n) return null;
    const hit = per.find((rec) => (rec.C[comp] ?? 0n) > 0n);
    if (!hit) return null;
    const n = ((hit.C[comp] ?? 0n) / g) * scale;
    if (n <= 0n) return null;
    return fractionToDecimal(hit.C[comp], n * 10000n);
  };
  const decA = priceOf(A, t, gA);
  const decB = priceOf(B, u, gB);
  return { ok: true, prices: { [A]: decA, [B]: decB }, derived: { [A]: decA, [B]: decB } };
}

/**
 * 一行目录 × 一套价格分支 × 一个参考版本 的完整尝试。
 * 返回 ok 或失败分类：
 *   kind='hard-falsified'  已知价分项无整数解 / 反解成功后仍不满足参考方程 ⇒ 与该候选矛盾（可排除）
 *   kind='missing-price'   缺某分项价、该分项费用>0，且反解未能唯一定出该价 ⇒ 规则 3：不许进 complete
 *                          （detail='underdetermined' 表示解不唯一；detail='inconsistent' 表示反解不成立）
 *   kind='unobserved'      消息缺分项观测，参考方程无法核对 ⇒ 无法判定
 *   kind='missing-price-no-observation' 同上但缺的是价（input/output 理论上有价，此处兜底）
 */
function solveWithCombo(combo, refV, std) {
  // 阶段 1：已定价分项（input / output / 目录已给出价的缓存分项）的整数原像 ——
  //         这条检查与"另一个缓存分项缺不缺价"无关，失败即可直接排除该候选。
  for (const comp of COMPONENTS) {
    const p = combo[comp];
    if (p === null) continue;          // 未知价：留给阶段 2 反解
    for (const m of std) {
      const c = m.costs[comp];
      if (c === null) return { ok: false, kind: 'unobserved', why: m.id + ' 缺少 ' + comp + ' 观测' };
      if (!tokensForCostAll(c, p).length) {
        return { ok: false, kind: 'hard-falsified', why: comp + ' 在 ' + m.id + ' 上无整数 token 解（p=' + p + ', c=' + c + '）' };
      }
    }
  }

  // 阶段 2：缺价 ⇒ 用 base 参考方程反解（规则 3 的落点）
  const declined = deriveCachePrices(combo, refV, std);
  if (!declined.ok) {
    if (declined.kind === 'unobserved') return { ok: false, kind: 'unobserved', why: declined.why };
    return {
      ok: false,
      kind: 'missing-price',
      detail: declined.kind === 'underdetermined' ? 'underdetermined' : 'inconsistent',
      why: declined.why,
    };
  }

  const eff = {};
  for (const comp of COMPONENTS) {
    const v = combo[comp] !== null ? combo[comp] : (declined.prices[comp] ?? null);
    eff[comp] = v === undefined ? null : v;
  }

  // 用公开的 fitPriceVector 复验：整数原像 + base 残差 + charged 恒等式，逐条消息
  const impliedTokens = {};
  for (const m of std) {
    const f = fitPriceVector({
      costs: m.costs,
      prices: eff,
      base: m.base,
      charged: m.charged,
      cm: m.cm,
      mm: m.mm,
      refVersions: [refV],
    });
    if (!f.ok) return { ok: false, kind: 'hard-falsified', why: 'fitPriceVector 未通过：' + f.reason + ' @ ' + m.id };
    if (f.chargedIdentity === false) return { ok: false, kind: 'hard-falsified', why: 'charged = base×cm×mm 不成立 @ ' + m.id };
    impliedTokens[m.id] = {
      in: f.impliedTokens.input,
      out: f.impliedTokens.output,
      cr: f.impliedTokens.cacheRead,
      cw: f.impliedTokens.cacheWrite,
    };
  }
  return {
    ok: true,
    prices: eff,
    derived: declined.derived || {},
    unconstrained: declined.unconstrained || [],
    impliedTokens,
    refVersion: refV.id,
  };
}

/** 一行目录的判定：complete / unconstrained / rejected。 */
function attemptRow(row, std, versions) {
  const opts = rowPriceOptions(row);
  const { combos, truncated } = branchCombos(opts);
  const seen = {
    hardFalsified: 0,      // 已知价分项直接矛盾 ⇒ 可排除
    missingPrice: 0,       // 缺价 + 费用>0，反解不成立或不唯一 ⇒ 规则 3：不许进 complete
    underdetermined: 0,
    unobserved: 0,
  };

  const positiveCost = (comp) => std.some((m) => m.costs[comp] !== null && quanta10(m.costs[comp]) !== 0n);
  const anyPositive = COMPONENTS.some(positiveCost);

  for (const combo of combos) {
    for (const refV of versions) {
      const r = solveWithCombo(combo, refV, std);
      if (r.ok) return { status: 'complete', combo, result: r, truncatedBranches: truncated };
      if (r.kind === 'missing-price') {
        seen.missingPrice++;
        if (r.detail === 'underdetermined') seen.underdetermined++;
      } else if (r.kind === 'unobserved') seen.unobserved++;
      else seen.hardFalsified++;
    }
  }

  // 规则 3：只要存在"缺价 + 费用>0 且反解没成功"的分支，该候选就不能被确认，
  //         也不声称被排除（要排除必须先有价或反解出价）⇒ unconstrained(MISSING-CACHE-PRICE)。
  if (seen.missingPrice > 0) {
    return {
      status: 'unconstrained',
      reason: 'MISSING-CACHE-PRICE',
      detail: seen.underdetermined > 0 ? (seen.hardFalsified > 0 ? 'mixed' : 'underdetermined') : 'inconsistent',
    };
  }
  if (!anyPositive) return { status: 'unconstrained', reason: 'ZERO-COST-COMPONENT', detail: 'zero-cost' };
  if (seen.unobserved > 0 && seen.hardFalsified === 0) {
    return { status: 'unconstrained', reason: 'NO-CONSTRAINT', detail: 'unobserved' };
  }
  return { status: 'rejected', detail: seen.unobserved > 0 ? 'unobserved+hard' : 'hard-falsified' };
}

/**
 * ★ 冻结导出：整个 /cost 响应 × 目录 ⇒ 冻结形状的 report。
 *
 * @param {{costJson:object, catalog:Array, refVersions?:Array}} input
 * @returns {{verdict:string, regime:object, complete:Array, unconstrained:Array,
 *            collisions:Array, ignored:object, boundary:string[]}}
 */
function identifyFromCost({ costJson, catalog, refVersions } = {}) {
  const versions = normalizeRefVersions(refVersions);
  const rows = Array.isArray(catalog) ? catalog : [];
  const messages = extractMessages(costJson);
  const std = messages.filter((m) => !m.isLongContext);
  const longCtx = messages.filter((m) => m.isLongContext);

  const report = {
    verdict: 'INSUFFICIENT-OBSERVATION',
    regime: {
      standardMessages: std.length,
      longContextMessages: longCtx.length,
      longContextRule: 'UNKNOWN',
    },
    complete: [],
    unconstrained: [],
    collisions: [],
    ignored: { unpricedRows: 0, note: '目录无 in/out 价 ⇒ 不参与、也不计入候选' },
    boundary: [],
  };

  const unpriced = [];
  const candidates = [];
  for (const row of rows) {
    const opts = rowPriceOptions(row);
    if (!opts.input.values || !opts.output.values) { unpriced.push(String(row && row.key)); continue; }
    candidates.push(row);
  }
  report.ignored.unpricedRows = unpriced.length;

  const derivedHits = [];
  const rejected = [];
  const unconstrainedDetail = { inconsistent: 0, underdetermined: 0, mixed: 0, zero: 0, unobserved: 0 };
  const partialObservation = messages.some((m) => COMPONENTS.some((c) => m.costs[c] === null));

  if (std.length > 0) {
    for (const row of candidates) {
      const key = String(row.key === undefined ? '' : row.key);
      const disp = String(row.disp === undefined || row.disp === null ? key : row.disp);
      const r = attemptRow(row, std, versions);
      if (r.status === 'complete') {
        const eff = r.result.prices;
        for (const comp of CACHE_COMPONENTS) if (r.result.derived[comp]) derivedHits.push(comp + '@' + key);
        report.complete.push({
          key,
          disp,
          org: row.org === undefined ? null : row.org,
          tier: row.tier === undefined ? null : row.tier,
          prices: {
            input: eff.input,
            output: eff.output,
            cacheRead: eff.cacheRead,
            cacheWrite: eff.cacheWrite,
          },
          refVersion: r.result.refVersion,
          impliedTokens: r.result.impliedTokens,
          messages: std.map((m) => m.id),
        });
      } else if (r.status === 'unconstrained') {
        if (unconstrainedDetail[r.detail] !== undefined) unconstrainedDetail[r.detail]++;
        report.unconstrained.push({ key, disp, reason: r.reason });
      } else {
        rejected.push(key);
      }
    }
  }

  report.complete.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  report.unconstrained.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 长上下文只做"事实观察"（不参与判定）：候选价向量下它的分项还能不能解出整数 token？
  let longCtxPriceFit = null;
  if (longCtx.length && report.complete.length) {
    const eff = report.complete[0].prices;
    longCtxPriceFit = longCtx.every((m) => COMPONENTS.every((comp) => {
      const c = m.costs[comp];
      const p = eff[comp];
      if (c === null || p === null || p === undefined) return true;
      return tokensForCostAll(c, p).length > 0;
    }));
  }

  // 碰撞：同价向量的多个模型（只能报碰撞，不能说"就是它"）
  const byVector = new Map();
  for (const c of report.complete) {
    const vk = priceVectorKey(c.prices);
    if (!byVector.has(vk)) byVector.set(vk, []);
    byVector.get(vk).push(c.key);
  }
  for (const [vectorKey, models] of byVector) {
    if (models.length > 1) report.collisions.push({ vectorKey, models: models.slice() });
  }
  report.collisions.sort((a, b) => (a.vectorKey < b.vectorKey ? -1 : a.vectorKey > b.vectorKey ? 1 : 0));

  if (std.length === 0) report.verdict = 'INSUFFICIENT-OBSERVATION';
  else if (report.complete.length === 0) report.verdict = 'NO-COMPLETE';
  else if (report.complete.length === 1) report.verdict = 'UNIQUE-COMPLETE';
  else report.verdict = 'MULTIPLE-COMPLETE';

  report.boundary = buildBoundary({
    report, std, longCtx, rows, unpriced, rejected, derivedHits, versions, partialObservation, unconstrainedDetail, longCtxPriceFit,
  });
  return report;
}

function buildBoundary({ report, std, longCtx, rows, unpriced, rejected, derivedHits, versions, partialObservation, unconstrainedDetail, longCtxPriceFit }) {
  const b = [];
  const strategy = std.length && std[0].pricingStrategy ? std[0].pricingStrategy : null;
  b.push('结论只来自 1 个会话的 ' + (std.length + longCtx.length) + ' 条带分项费用的消息（' +
    std.length + ' 条非长上下文 + ' + longCtx.length + ' 条长上下文），未在第二个会话/第二个模型上复现 ⇒ 强证据，但不是全体结论。');
  b.push('本批 ' + std.length + ' 条非长上下文消息的输入费用全部为 0 ⇒ n_in 恒为 0，' +
    '参考方程里的 input 项系数（ref-10-05/08 的 2156）**本批未被验证**，任何系数都能满足这一项。');
  b.push('候选的 cacheRead/cacheWrite 单价凡是目录里没有的，都是由 base 参考方程反解出来的' +
    '（反解值），不是目录实测值；反解要求单价严格为正，且全消息共用同一价向量。');
  b.push('长上下文（isLongContext=true）是另一套计价，规则 UNKNOWN（归 T3），本卡不判定：' +
    longCtx.length + ' 条长上下文消息不参与 complete 判定，只计数进 regime。');
  b.push('候选集合 ≠ 模型身份已证明：同价 / 同价向量 / 整数倍关系只能报候选与 collisions；' +
    '即使 verdict 是 UNIQUE-COMPLETE，也只表示"在该目录宇宙内的唯一"，不代表模型身份被证明。');
  b.push('目录 ' + rows.length + ' 行中 ' + unpriced.length + ' 行没有 in/out 价 ⇒ 计入 ignored，' +
    '既不参与候选，也无法被本方法排除（"不在列表的忽视"）。');
  b.push('费用为 0 的分项不提供单价约束（不能说明单价是 0，也不能说明是免费）；' +
    '本实现里"零费用 ⇒ n=0"只出现在单价已知且严格为正，或反解假设单价严格为正的情形。');
  b.push('输入单价的区分度：本批 input 费用恒为 0 ⇒ 任何 p_in 都能通过，' +
    '候选之间的差异完全来自 output 与缓存两项。');
  if (strategy) b.push('pricingStrategy = ' + strategy + '（来自观测，不参与判定）。');
  if (report.complete.length) {
    const vers = [...new Set(report.complete.map((c) => c.refVersion))];
    b.push('命中的参考费率版本：' + vers.join(', ') + '（本卡内置 ' + versions.map((v) => v.id).join(', ') +
      '；逐版本尝试，未命中多个版本）。');
    b.push('charged = base × costMultiplier × marginMultiplier 在候选命中的消息上逐条校验通过；' +
      '该恒等式只作一致性校验，**不参与**候选判定。');
  }
  if (derivedHits.length) {
    const uniq = [...new Set(derivedHits)];
    b.push('反解得到的单价出现在 ' + uniq.length + ' 处（分项@模型）：' + uniq.slice(0, 8).join(', ') +
      (uniq.length > 8 ? ' …' : '') + '；这些条目的 prices 是反解值。');
  }
  if (rejected.length) {
    b.push('另有 ' + rejected.length + ' 行有价候选被排除（已知价分项无整数 token 解，或 base 参考方程残差 ≠ 0，或跨消息价不一致）。');
  }
  if (report.unconstrained.length) {
    const d = unconstrainedDetail || {};
    b.push('unconstrained 里的候选按规则 3 一律**不许当成通过**；其中 ' +
      (d.inconsistent || 0) + ' 行是"缺价 + 反解不成立（属未确认的排除）"，' +
      (d.underdetermined || 0) + ' 行是"缺价 + 反解不唯一（既不能确认也不能排除）"，' +
      (d.mixed || 0) + ' 行两种情况都有，' +
      (d.zero || 0) + ' 行是零费用无约束，' +
      (d.unobserved || 0) + ' 行是观测缺分项。');
  }
  if (partialObservation) b.push('存在未观测分项（分项字段缺失）⇒ 该消息的参考方程无法核对，相关候选只能进 unconstrained。');
  if (longCtx.length && longCtxPriceFit === true) {
    b.push('实测：' + longCtx.length + ' 条长上下文消息的分项费用在候选价向量下**同样能解出整数 token 数**，' +
      '但其 base 不满足同一参考方程 ⇒ 长上下文是另一套计价，不能并入本判定（按规则 6 排除）。');
  } else if (longCtx.length && longCtxPriceFit === false) {
    b.push('实测：' + longCtx.length + ' 条长上下文消息的分项费用在候选价向量下**解不出**整数 token 数 ⇒ ' +
      '长上下文连模型单价都可能不同，更不能并入本判定（按规则 6 排除）。');
  }
  return b;
}

  const __IDENTIFY_BUNDLE__ = {"schema":"identify-bundle/1","source":"data/arena-models-derived.json","sourceSha256":"5c65b3de93e54fe63e8ec82cce600124304f4f946da696aa680988ad35b9f9ec","catalogRows":466,"pricedRows":366,"unpricedRows":100,"refs":[{"id":"ref-10-05/08","input":2156,"output":6468,"cacheRead":100,"cacheWrite":2695},{"id":"ref-10-01","input":2156,"output":12000,"cacheRead":200,"cacheWrite":2695}],"vectorGroups":[{"vectorKey":"1000|5000|100|1250","keys":["contenders/gpt-6-astra-max-agent","contenders/claude-fable-5-agent","claude-fable-5-text"]},{"vectorKey":"1000|5000|25|1250","keys":["contenders/claude-fable-5.1-max-agent","claude-fable-5.1-max-text"]},{"vectorKey":"100|500|10|125","keys":["claude-haiku-4-5-20251001","claude-3-5-haiku-20241022"]},{"vectorKey":"1500|7500|150|1875","keys":["claude-opus-4-1-20250805-thinking-16k","claude-opus-4-20250514-thinking-16k","claude-3-opus-20240229"]},{"vectorKey":"200|1000|20|250","keys":["contenders/claude-sonnet-5-agent","claude-sonnet-5-text"]},{"vectorKey":"200|1200|20|250","keys":["contenders/gpt-5.6-terra-xhigh-agent","gpt-5.6-terra-xhigh-text"]},{"vectorKey":"200|600|25|250","keys":["contenders/paisley-n9x0","kinsley-mrp8"]},{"vectorKey":"300|1500|30|375","keys":["contenders/kivine-wxzc-agent","claude-sonnet-4-5-20250929-thinking-32k","claude-sonnet-4-5-20250929","grok-4-fast-chat","grok-3-preview-02-24","claude-sonnet-4-20250514-thinking-32k","claude-sonnet-4-20250514","claude-3-7-sonnet-20250219-thinking-32k","claude-3-5-sonnet-20241022","claude-3-7-sonnet-20250219","claude-3-5-sonnet-20240620","claude-3-sonnet-20240229","command-r-plus"]},{"vectorKey":"30|250|3|8.33333333","keys":["gemini-2.5-flash","gemini-2.5-flash-preview-09-2025"]},{"vectorKey":"32|128|6.4|40","keys":["contenders/qwen3.7-plus-agent","qwen3.7-plus"]},{"vectorKey":"400|2000|20|500","keys":["contenders/claude-opus-5.5-high-vertex-agent","contenders/gpt-5.6-sol-xhigh-agent","claude-opus-5.5-high-vertex","gpt-5.6-sol-xhigh-text"]},{"vectorKey":"500|2500|50|625","keys":["contenders/claude-opus-5-max-agent","contenders/claude-opus-5-high-agent","contenders/claude-opus-4-8-thinking-agent","claude-opus-4-6-thinking","claude-opus-4-7-thinking","claude-opus-4-6","claude-opus-4-7","claude-opus-5-high-text","claude-opus-5-max-text","claude-opus-4-8-thinking-text","claude-opus-4-8-text","claude-opus-4-5-20251101-thinking-32k","claude-opus-4-5-20251101","claude-opus-4-20250514"]},{"vectorKey":"50|300|5|8.33333333","keys":["gemini-3-flash","gemini-3-flash-thinking-minimal"]},{"vectorKey":"75|375|7.5|4.16666667","keys":["contenders/skimaki-kwc6-agent","contenders/andwise-evfd-agent","contenders/gemini-3.6-flash-agent","contenders/mistral-medium-3.5-v2-agent","skimaki-kwc6","andwise-evfd","gemini-3.6-flash","mistral-medium-3.5-text"]}],"rows":[["agent","contenders/claude-opus-5.5-high-vertex-agent","Claude Opus 5.5 (High)","Anthropic",null,"4","20","0.2","5"],["agent","contenders/gpt-6-astra-max-agent","GPT 6 Astra (Max)","OpenAI","max","10","50","1","12.5"],["agent","contenders/claude-fable-5.1-max-agent","Claude Fable 5.1 (Max)","Anthropic","max","10","50","0.25","12.5"],["agent","contenders/gpt-6.1-sol-max-agent","GPT 6.1 Sol (Max)","OpenAI","max","2","10",["0.1","0.2"],"2.5"],["agent","contenders/gpt-6-sol-max-agent","GPT 6 Sol (Max)","OpenAI","max","2","10",["0.1","0.2"],"2.5"],["agent","contenders/barium-bb-v2-4xts-agent","Gemini 4 Argon (High)","Google",null,"2","10",["0.1","0.2"],"2.5"],["agent","contenders/claude-fable-5-agent","Claude Fable 5 (High)","Anthropic",null,"10","50","1","12.5"],["agent","contenders/claude-opus-5-max-agent","Claude Opus 5 (Max)","Anthropic","max","5","25","0.5","6.25"],["agent","contenders/claude-opus-5-high-agent","Claude Opus 5 (High)","Anthropic","high","5","25","0.5","6.25"],["agent","contenders/claude-opus-4-8-thinking-agent","Claude Opus 4.8 (High)","Anthropic",null,"5","25","0.5","6.25"],["agent","contenders/gpt-5.6-sol-xhigh-agent","GPT 5.6 Sol (xHigh)","OpenAI",null,"4","20","0.2","5"],["agent","contenders/claude-sonnet-5-agent","Claude Sonnet 5 (High)","Anthropic",null,"2","10","0.2","2.5"],["agent","contenders/gpt-5.5-xhigh-agent","GPT 5.5 (xHigh)","OpenAI",null,"5","30","0.5",null],["agent","contenders/muse-spark-1-3-max-agent","Muse Spark 1.3 (Max)","Meta","max","1.25","4.25","0.15",null],["agent","contenders/deepseek-v4.1-flash-max-20260910-agent","Deepseek V4.1 Flash (Max)","DeepSeek",null,"0.3","1.2","0.006",null],["agent","contenders/kivine-wxzc-agent","Kimi K3 (Max)","Moonshot",null,"3","15","0.3","3.75"],["agent","contenders/phoenix-qcs2-agent","Hy4 preview","Tencent",null,"0.834","2.501",null,null],["agent","contenders/mimo-v2-6-pro-public-agent","MiMo V2.6 Pro","Xiaomi",null,"0.435","0.87","0.0036",null],["agent","contenders/glm-5.2-agent","GLM 5.2 (Max)","Z.ai",null,"1.4","4.4",null,null],["agent","contenders/grok-4.7-xhigh-public-agent","Grok 4.7 (xHigh)","SpaceXAI",null,"2","6",["0.5","0.25","0.3","0.2"],null],["agent","contenders/skimaki-kwc6-agent","Gemini 3.8 Flash (High)","Google",null,"0.75","3.75","0.075","0.0416666667"],["agent","contenders/paisley-n9x0","Qwen3.8 Max","Alibaba",null,"2","6","0.25","2.5"],["agent","contenders/glm-5.3-agent","GLM 5.3 (Max)","Z.ai",null,"1.4","4.4",null,null],["agent","contenders/gpt-6-luna-max-agent","GPT 6 Luna (Max)","OpenAI","max","0.1","0.5",null,null],["agent","contenders/grok-4.5-agent","Grok 4.5","SpaceXAI",null,"2","6","0.3",null],["agent","contenders/gpt-5.4-high-code-arena-harness-agent","GPT 5.4 (High)","OpenAI",null,"2.5","15","0.25",null],["agent","contenders/gpt-5.5-agent","GPT 5.5","OpenAI",null,"5","30","0.5",null],["agent","contenders/gpt-5.6-terra-xhigh-agent","GPT 5.6 Terra (xHigh)","OpenAI",null,"2","12","0.2","2.5"],["agent","contenders/mimo-v2-6-flash-agent","MiMo V2.6 Flash","Xiaomi",null,"0.14","0.28","0.0028",null],["agent","contenders/step-5-preview-agent","Step 5 Preview","StepFun",null,"1","2.7","0.05",null],["agent","contenders/farris-ees5-agent","Qwen3.8 Flash Next","Alibaba",null,"0.16","0.47",null,"0.2"],["agent","contenders/glm-5.3-flash-agent","GLM 5.3 Flash","Z.ai",null,"0.06","0.2",null,null],["agent","contenders/gpt-5.6-luna-xhigh-agent","GPT 5.6 Luna (xHigh)","OpenAI",null,"0.2","1.2",null,null],["agent","contenders/qwen3.8-27b-code-agent","Qwen 3.8 27B","Alibaba",null,"0.4","3",null,"0.5"],["agent","contenders/andwise-evfd-agent","Gemini 3.7 Flash (High)","Google",null,"0.75","3.75","0.075","0.0416666667"],["agent","contenders/muse-spark-1.2-xhigh-agent","Muse Spark 1.2 (xHigh)","Meta",null,"1.25","4.25","0.15",null],["agent","contenders/super-nova-ext-3tam-agent","Muse Spark 1.1","Meta",null,"1.25","4.25","0.15",null],["agent","contenders/hy3-tencent-cloud-agent","Hy3","Tencent",null,"0.132","0.528",null,null],["agent","contenders/mistral-large-4-agent","mistral-large-4","Mistral",null,"0.68","2.09",null,null],["agent","contenders/minimax-m3-first-party","Minimax M3","MiniMax",null,"0.3","1.2",["0.06","0.03"],null],["agent","contenders/qwen3.7-plus-agent","Qwen3.7 Plus","Alibaba",null,"0.32","1.28","0.064","0.4"],["agent","contenders/mimo-v2.5-pro-agent","Mimo V2.5 Pro","Xiaomi",null,"0.435","0.87","0.0036",null],["agent","contenders/gemini-3.6-flash-agent","Gemini 3.6 Flash (High)","Google",null,"0.75","3.75","0.075","0.0416666667"],["agent","contenders/gemini-3.1-pro-preview-agent","Gemini 3.1 Pro Preview","Google",null,"1","6",null,null],["agent","contenders/inkling-small","Inkling Small","Thinky",null,"0.45","1.2",null,null],["agent","contenders/inkling-agent","Inkling","Thinky",null,"1","4.05","0.17",null],["agent","contenders/mistral-medium-3.5-v2-agent","Mistral Medium 3.5","Mistral",null,"0.75","3.75","0.075","0.0416666667"],["agent","contenders/solar-pro4-agent","Solar Pro 4","Upstage",null,"0.09","0.36","0.018",null],["text","barium-bb-wlqc-text","gemini-4-argon-high","Google",null,"2","10",["0.1","0.2"],"2.5"],["text","claude-opus-5.5-high-vertex","claude-opus-5.5-high","Anthropic",null,"4","20","0.2","5"],["text","claude-opus-4-6-thinking","claude-opus-4-6-high","Anthropic",null,"5","25","0.5","6.25"],["text","claude-fable-5-text","claude-fable-5-high","Anthropic",null,"10","50","1","12.5"],["text","claude-opus-4-7-thinking","claude-opus-4-7-high","Anthropic",null,"5","25","0.5","6.25"],["text","claude-fable-5.1-max-text","claude-fable-5.1-max","Anthropic",null,"10","50","0.25","12.5"],["text","claude-opus-4-6","claude-opus-4-6","Anthropic",null,"5","25","0.5","6.25"],["text","skimaki-kwc6","gemini-3.8-flash-high","Google",null,"0.75","3.75","0.075","0.0416666667"],["text","muse-spark-1-3-max-bhma-text","muse-spark-1.3-max","Meta",null,"1.25","4.25","0.15",null],["text","claude-opus-4-7","claude-opus-4-7","Anthropic",null,"5","25","0.5","6.25"],["text","muse-spark-1.2-xhigh-text","muse-spark-1.2 (xHigh)","Meta",null,"1.25","4.25","0.15",null],["text","super-nova-ext-3tam-text","muse-spark-1.1","Meta",null,"1.25","4.25","0.15",null],["text","claude-opus-5-high-text","claude-opus-5-high","Anthropic",null,"5","25","0.5","6.25"],["text","claude-opus-5-max-text","claude-opus-5-max","Anthropic",null,"5","25","0.5","6.25"],["text","gemini-3.1-pro-preview","gemini-3.1-pro-preview","Google",null,"1","6",null,null],["text","andwise-evfd","gemini-3.7-flash-high","Google",null,"0.75","3.75","0.075","0.0416666667"],["text","gemini-3-pro","gemini-3-pro","Google",null,"2","12","0.2","0.375"],["text","gpt-5.6-sol-xhigh-text","gpt-5.6-sol-xhigh","OpenAI",null,"4","20","0.2","5"],["text","gpt-6.1-sol-max","gpt-6.1-sol-max","OpenAI","max","2","10",["0.1","0.2"],"2.5"],["text","kinsley-mrp8","qwen3.8-max","Alibaba",null,"2","6","0.25","2.5"],["text","gemini-3.6-flash","gemini-3.6-flash-high","Google",null,"0.75","3.75","0.075","0.0416666667"],["text","gpt-5.5-high-text","gpt-5.5-high","OpenAI",null,"5","30","0.5",null],["text","claude-opus-4-8-thinking-text","claude-opus-4-8-high","Anthropic",null,"5","25","0.5","6.25"],["text","mimo-v2-6-pro-mw0j-text","mimo-v2.6-pro","Xiaomi",null,"0.435","0.87","0.0036",null],["text","glm-5.3","glm-5.3-max","Z.ai",null,"1.4","4.4",null,null],["text","gemini-3.5-flash-high-public","gemini-3.5-flash-high","Google",null,"0.75","4.5","0.075",null],["text","gpt-5.5-text","gpt-5.5","OpenAI",null,"5","30","0.5",null],["text","gemini-3.5-flash-medium","gemini-3.5-flash-medium","Google","medium","0.75","4.5","0.075",null],["text","gpt-5.2-chat-latest","gpt-5.2-chat-latest-20260210","OpenAI",null,"1.75","14","0.175",null],["text","claude-sonnet-5-5-xhigh","claude-sonnet-5.5-xhigh","Anthropic",null,"2","10",["0.1","0.2"],"2.5"],["text","glm-5.2-text","glm-5.2-max","Z.ai",null,"1.4","4.4",null,null],["text","gpt-5.4-high-no-system-prompt","gpt-5.4-high","OpenAI",null,"2.5","15","0.25",null],["text","melyora-9qr6","qwen3.7-max-preview","Alibaba",null,"1.475","4.425","0.295","1.84375"],["text","glm-5.3-flash-text","glm-5.3-flash","Z.ai",null,"0.06","0.2",null,null],["text","deepseek-v4.1-flash-max-20260910-text","deepseek-v4.1-flash-max","DeepSeek",null,"0.3","1.2","0.006",null],["text","claude-opus-4-8-text","claude-opus-4-8","Anthropic",null,"5","25","0.5","6.25"],["text","claude-opus-4-5-20251101-thinking-32k","claude-opus-4-5-20251101-high-32k","Anthropic",null,"5","25","0.5","6.25"],["text","gpt-5.5-instant","gpt-5.5-instant","OpenAI",null,"5","30","0.5",null],["text","gemini-3-flash","gemini-3-flash","Google",null,"0.5","3","0.05","0.0833333333"],["text","claude-sonnet-4-6","claude-sonnet-4-6","Anthropic",null,"1.5","7.5",null,"1.875"],["text","grok-4.20-beta-0309-reasoning","grok-4.20-beta-0309-reasoning","SpaceXAI",null,"1.25","2.5","0.2",null],["text","grok-4.20-multi-agent-beta-0309","grok-4.20-multi-agent-beta-0309","SpaceXAI",null,"1.25","2.5","0.2",null],["text","claude-opus-4-5-20251101","claude-opus-4-5-20251101","Anthropic",null,"5","25","0.5","6.25"],["text","mimo-v2.5-pro-text","mimo-v2.5-pro","Xiaomi",null,"0.435","0.87","0.0036",null],["text","zero-prism","ernie-5.1","Baidu",null,"0.5634","2.5353",null,null],["text","gpt-5.6-terra-xhigh-text","gpt-5.6-terra-xhigh","OpenAI",null,"2","12","0.2","2.5"],["text","grok-4.5-text","grok-4.5","SpaceXAI",null,"2","6","0.3",null],["text","gpt-5.4-no-system-prompt","gpt-5.4","OpenAI",null,"2.5","15","0.25",null],["text","kiteki","qwen3.5-max-preview","Alibaba",null,"1.2","6",null,"1.5"],["text","deepseek-v4-pro-high-20260813-text","deepseek-v4-pro-high-20260813","DeepSeek",null,"1.32","3.96","0.0264",null],["text","glm-5.1-text","glm-5.1","Z.ai",null,"1.4","4.4",null,null],["text","claude-sonnet-5-text","claude-sonnet-5-high","Anthropic",null,"2","10","0.2","2.5"],["text","kimi-k2.6-text","kimi-k2.6","Moonshot",null,"0.95","4","0.15",null],["text","kizen-beta","qwen3.6-max-preview","Alibaba",null,"1.027","6.162",null,"1.28375"],["text","gemini-3-flash-thinking-minimal","gemini-3-flash (thinking-minimal)","Google","minimal","0.5","3","0.05","0.0833333333"],["text","deepseek-v4-pro-ch1-text","deepseek-v4-pro","DeepSeek",null,"1.32","3.96","0.0264",null],["text","glm-5","glm-5","Z.ai",null,"1","3.2",null,null],["text","claude-sonnet-4-5-20250929-thinking-32k","claude-sonnet-4-5-20250929-high-32k","Anthropic",null,"3","15","0.3","3.75"],["text","qwen3.7-plus","qwen3.7-plus","Alibaba",null,"0.32","1.28","0.064","0.4"],["text","gpt-6-sol-max-text","gpt-6-sol-max","OpenAI",null,"2","10",["0.1","0.2"],"2.5"],["text","gpt-5.1-high","gpt-5.1-high","OpenAI","high","0.625","5",null,null],["text","claude-sonnet-4-5-20250929","claude-sonnet-4-5-20250929","Anthropic",null,"3","15","0.3","3.75"],["text","gemini-3.5-flash-lite","gemini-3.5-flash-lite","Google",null,"0.15","1.25",null,null],["text","deepseek-v4-pro-ch1-thinking-text","deepseek-v4-pro-high-preview","DeepSeek",null,"1.32","3.96","0.0264",null],["text","grok-4.6-high-public-text","grok-4.6-high","SpaceXAI",null,"2","6",["0.5","0.25","0.3","0.2"],null],["text","hy3-tencent-cloud-text","hy3","Tencent",null,"0.132","0.528",null,null],["text","gpt-5.6-luna-xhigh-text","gpt-5.6-luna-xhigh","OpenAI",null,"0.2","1.2",null,null],["text","pteronura-text","gemma-4-31b","Google",null,"0.99","1.49",null,null],["text","mimo-v2-6-flash-text","mimo-v2.6-flash","Xiaomi",null,"0.14","0.28","0.0028",null],["text","gpt-5.3-chat-latest","gpt-5.3-chat-latest","OpenAI",null,"1.75","14","0.175",null],["text","kimi-k2.5-text","kimi-k2.5-thinking","Moonshot",null,"0.6","3",null,null],["text","claude-opus-4-1-20250805-thinking-16k","claude-opus-4-1-20250805-thinking-16k","Anthropic",null,"15","75","1.5","18.75"],["text","claude-opus-4-1-20250805","claude-opus-4-1-20250805","Anthropic",null,"7.5","37.5",null,"9.375"],["text","mimo-v2-pro","mimo-v2-pro","Xiaomi",null,"1.1","3.3",null,null],["text","step-5-preview-agent","Step 5 Preview","StepFun",null,"1","2.7","0.05",null],["text","gpt-5.4-mini-high","gpt-5.4-mini-high","OpenAI","high","0.75","4.5","0.075",null],["text","gemini-2.5-pro","gemini-2.5-pro","Google",null,"1.25","10","0.125","0.375"],["text","gpt-4.5-preview-2025-02-27","gpt-4.5-preview-2025-02-27","OpenAI",null,"75","150",null,null],["text","qwen3.6-plus-text","qwen3.6-plus","Alibaba",null,"0.325","1.95",null,"0.40625"],["text","chatgpt-4o-latest-20250326","chatgpt-4o-latest-20250326","OpenAI",null,"5","15",null,null],["text","grok-4.7-xhigh-public","grok-4.7-xhigh","SpaceXAI",null,"2","6",["0.5","0.25","0.3","0.2"],null],["text","gpt-6-luna-max-text","gpt-6-luna-max","OpenAI",null,"0.1","0.5",null,null],["text","qwen3.5-397b-a17b-text","qwen3.5-397b-a17b","Alibaba",null,"0.55","3.5","0.225","0.6875"],["text","grok-4.3-text","grok-4.3","SpaceXAI",null,"1.25","2.5","0.2",null],["text","glm-4.7","glm-4.7","Z.ai",null,"0.6","2.2","0.11",null],["text","inkling-text","inkling","Thinky",null,"1","4.05","0.17",null],["text","minimax-m3","minimax-m3","MiniMax",null,"0.3","1.2","0.06",null],["text","deepseek-v4-ch3-thinking-text","deepseek-v4-flash-high-preview","DeepSeek",null,"0.3","1.2","0.006",null],["text","gpt-5.1","gpt-5.1","OpenAI",null,"0.625","5",null,null],["text","qwen3.8-27b","qwen3.8-27b","Alibaba",null,"0.4","3",null,"0.5"],["text","gpt-5.2-high","gpt-5.2-high","OpenAI","high","0.875","7",null,null],["text","deepseek-v4-ch3-text","deepseek-v4-flash","DeepSeek",null,"0.3","1.2","0.006",null],["text","gpt-5.2","gpt-5.2","OpenAI",null,"0.875","7",null,null],["text","gpt-5-high","gpt-5-high","OpenAI","high","0.625","5",null,null],["text","qwen3-max-preview","qwen3-max-preview","Alibaba",null,"0.78","3.9",null,"0.975"],["text","mimo-v2.5-text","mimo-v2.5","Xiaomi",null,"0.14","0.28","0.0028",null],["text","glm-5v-turbo","glm-5v-turbo","Z.ai",null,"1.2","4","0.24",null],["text","gemini-3.1-flash-lite-preview","gemini-3.1-flash-lite-preview","Google",null,"0.25","1.5","0.025","0.0833333333"],["text","o3-2025-04-16","o3-2025-04-16","OpenAI",null,"2","8","0.5",null],["text","mimo-v2-omni","mimo-v2-omni","Xiaomi",null,"0.44","2.2",null,null],["text","grok-4-1-fast-reasoning","grok-4-1-fast-reasoning","SpaceXAI",null,"0.2","0.5",null,null],["text","kimi-k2.5-instant","kimi-k2.5-instant","Moonshot",null,"0.45","2.25",null,null],["text","kimi-k2-thinking-turbo","kimi-k2-thinking-turbo","Moonshot",null,"0.57","2.3",null,null],["text","mistral-large-4-text","mistral-large-4","Mistral",null,"0.68","2.09",null,null],["text","mistral-medium-3.5-text","mistral-medium-3.5","Mistral",null,"0.75","3.75","0.075","0.0416666667"],["text","gpt-5-chat","gpt-5-chat","OpenAI",null,"5","30","0.5",null],["text","claude-opus-4-20250514-thinking-16k","claude-opus-4-20250514-thinking-16k","Anthropic",null,"15","75","1.5","18.75"],["text","deepseek-v3.2-exp-thinking","deepseek-v3.2-exp-thinking","DeepSeek",null,"0.27","0.41","0.0054",null],["text","deepseek-v3.2","deepseek-v3.2","DeepSeek",null,"0.259","0.42","0.00518",null],["text","glm-4.6","glm-4.6","Z.ai",null,"0.43","1.75",null,null],["text","qwen3-max-2025-09-23","qwen3-max-2025-09-23","Alibaba",null,"0.78","3.9",null,"0.975"],["text","deepseek-v3.2-thinking","deepseek-v3.2-thinking","DeepSeek",null,"0.259","0.42","0.00518",null],["text","qwen3-235b-a22b-instruct-2507","qwen3-235b-a22b-instruct-2507","Alibaba",null,"0.264","1.06",null,"0.33"],["text","deepseek-v3.2-exp","deepseek-v3.2-exp","DeepSeek",null,"0.27","0.41","0.0054",null],["text","deepseek-r1-0528","deepseek-r1-0528","DeepSeek",null,"0.5","2.15","0.01",null],["text","grok-4-fast-chat","grok-4-fast-chat","SpaceXAI",null,"3","15","0.3","3.75"],["text","kimi-k2-0905-preview","kimi-k2-0905-preview","Moonshot",null,"0.6","2.5",null,null],["text","kimi-k2-0711-preview","kimi-k2-0711-preview","Moonshot",null,"0.6","2.5","0.15",null],["text","deepseek-v3.1","deepseek-v3.1","DeepSeek",null,"1.23","4.94","0.0246",null],["text","qwen3.5-122b-a10b","qwen3.5-122b-a10b","Alibaba",null,"0.26","2.08",null,"0.325"],["text","deepseek-v3.1-terminus-thinking","deepseek-v3.1-terminus-thinking","DeepSeek",null,"0.27","1","0.0054",null],["text","deepseek-v3.1-thinking","deepseek-v3.1-thinking","DeepSeek",null,"1.23","4.94","0.0246",null],["text","deep-octo","minimax-m2.7","MiniMax",null,"0.3","1.2",["0.06","0.03"],null],["text","deepseek-v3.1-terminus","deepseek-v3.1-terminus","DeepSeek",null,"0.27","1","0.0054",null],["text","gpt-4.1-2025-04-14","gpt-4.1-2025-04-14","OpenAI",null,"2","8","0.5",null],["text","claude-opus-4-20250514","claude-opus-4-20250514","Anthropic",null,"5","25","0.5","6.25"],["text","claude-haiku-4-5-20251001","claude-haiku-4-5-20251001","Anthropic",null,"1","5","0.1","1.25"],["text","mistral-large-3","mistral-large-3","Mistral",null,"0.5","1.5","0.05",null],["text","qwen3-vl-235b-a22b-instruct","qwen3-vl-235b-a22b-instruct","Alibaba",null,"0.287","1.147",null,"0.35875"],["text","grok-3-preview-02-24","grok-3-preview-02-24","SpaceXAI",null,"3","15","0.3","3.75"],["text","grok-4-0709","grok-4-0709","SpaceXAI",null,"1.25","2.5","0.2",null],["text","glm-4.5","glm-4.5","Z.ai",null,"0.6","2.2","0.11",null],["text","gemini-2.5-flash","gemini-2.5-flash","Google",null,"0.3","2.5","0.03","0.0833333333"],["text","hunyuan-hy3-preview-text","hunyuan-hy3-preview","Tencent",null,"0.29","1.17",null,null],["text","qwen3.5-27b","qwen3.5-27b","Alibaba",null,"0.26","2.6",null,"0.325"],["text","mistral-medium-2508","mistral-medium-2508","Mistral",null,"0.4","2",null,null],["text","inkling-small","Inkling Small","Thinky",null,"0.45","1.2",null,null],["text","grok-4-fast-reasoning","grok-4-fast-reasoning","SpaceXAI",null,"0.2","0.5",null,null],["text","gemini-2.5-flash-preview-09-2025","gemini-2.5-flash-preview-09-2025","Google",null,"0.3","2.5","0.03","0.0833333333"],["text","o1-2024-12-17","o1-2024-12-17","OpenAI",null,"15","60","7.5",null],["text","qwen3-235b-a22b-no-thinking","qwen3-235b-a22b-no-thinking","Alibaba",null,"0.455","1.82",null,"0.56875"],["text","claude-sonnet-4-20250514-thinking-32k","claude-sonnet-4-20250514-thinking-32k","Anthropic",null,"3","15","0.3","3.75"],["text","gpt-5.4-nano-high","gpt-5.4-nano-high","OpenAI","high","0.2","1.25",null,null],["text","longcat-flash-chat","longcat-flash-chat","Meituan",null,"0.2","0.8",null,null],["text","qwen3-235b-a22b-thinking-2507","qwen3-235b-a22b-thinking-2507","Alibaba",null,"0.23","2.3",null,"0.2875"],["text","qwen3-next-80b-a3b-instruct","qwen3-next-80b-a3b-instruct","Alibaba",null,"0.09","1.1",null,"0.1125"],["text","deepseek-r1","deepseek-r1","DeepSeek",null,"0.7","2.5","0.014",null],["text","deepseek-v3-0324","deepseek-v3-0324","DeepSeek",null,"1.14","4.56","0.0228",null],["text","qwen3-vl-235b-a22b-thinking","qwen3-vl-235b-a22b-thinking","Alibaba",null,"0.4","4",null,"0.5"],["text","qwen3.5-35b-a3b","qwen3.5-35b-a3b","Alibaba",null,"0.08","0.75","0.04","0.1"],["text","step-3.5-flash","step-3.5-flash","StepFun",null,"0.1","0.3",null,null],["text","mimo-v2-flash","mimo-v2-flash (non-thinking)","Xiaomi",null,"0.1","0.3",null,null],["text","o4-mini-2025-04-16","o4-mini-2025-04-16","OpenAI",null,"1.1","4.4",["0.275","0.55"],null],["text","claude-sonnet-4-20250514","claude-sonnet-4-20250514","Anthropic",null,"3","15","0.3","3.75"],["text","minimax-m2.5","minimax-m2.5","MiniMax",null,"0.27","1.08","0.027",null],["text","gpt-5-mini-high","gpt-5-mini-high","OpenAI","high","0.125","1",null,null],["text","o1-preview","o1-preview","OpenAI",null,"15","60","7.5",null],["text","claude-3-7-sonnet-20250219-thinking-32k","claude-3-7-sonnet-20250219-thinking-32k","Anthropic",null,"3","15","0.3","3.75"],["text","qwen3-coder-480b-a35b-instruct","qwen3-coder-480b-a35b-instruct","Alibaba",null,"0.65","3.25",null,"0.8125"],["text","mistral-medium-2505","mistral-medium-2505","Mistral",null,"0.4","2",null,null],["text","mimo-v2-flash-thinking-v2","mimo-v2-flash (thinking)","Xiaomi",null,"0.1","0.3",null,null],["text","solar-pro4-20260805","solar-pro4","Upstage",null,"0.09","0.36","0.018",null],["text","minimax-m2.1-preview","minimax-m2.1-preview","MiniMax",null,"0.3","1.2","0.03",null],["text","gpt-4.1-mini-2025-04-14","gpt-4.1-mini-2025-04-14","OpenAI",null,"0.4","1.6",null,null],["text","qwen3-30b-a3b-instruct-2507","qwen3-30b-a3b-instruct-2507","Alibaba",null,"0.1","0.3",null,"0.125"],["text","gemini-2.5-flash-lite-preview-09-2025-no-thinking","gemini-2.5-flash-lite-preview-09-2025-no-thinking","Google",null,"0.1","0.4",null,null],["text","glm-4.6v","glm-4.6v","Z.ai",null,"0.3","0.9",null,null],["text","trinity-large","trinity-large-preview","",null,"0.15","0.45",null,null],["text","qwen3-235b-a22b","qwen3-235b-a22b","Alibaba",null,"0.455","1.82",null,"0.56875"],["text","gemini-2.5-flash-lite-preview-06-17-thinking","gemini-2.5-flash-lite-preview-06-17-thinking","Google",null,"0.1","0.4",null,null],["text","claude-3-5-sonnet-20241022","claude-3-5-sonnet-20241022","Anthropic",null,"3","15","0.3","3.75"],["text","glm-4.5-air","glm-4.5-air","Z.ai",null,"0.13","0.85","0.025",null],["text","claude-3-7-sonnet-20250219","claude-3-7-sonnet-20250219","Anthropic",null,"3","15","0.3","3.75"],["text","qwen3-next-80b-a3b-thinking","qwen3-next-80b-a3b-thinking","Alibaba",null,"0.15","1.2",null,"0.1875"],["text","trinity-large-thinking","trinity-large-thinking","",null,"0.25","0.8",null,null],["text","gemma-3-27b-it","gemma-3-27b-it","Google",null,"0.08","0.45",null,null],["text","glm-4.7-flash-fireworks","glm-4.7-flash","Z.ai",null,"0.0605","0.4",null,null],["text","grok-3-mini-high","grok-3-mini-high","SpaceXAI","high","0.25","1.27",null,null],["text","minimax-m1","minimax-m1","MiniMax",null,"0.55","2.2",null,null],["text","o3-mini-high","o3-mini-high","OpenAI","high","1.1","4.4",["0.275","0.55"],null],["text","gemini-2.0-flash-001","gemini-2.0-flash-001","Google",null,"0.1","0.4",null,null],["text","deepseek-v3","deepseek-v3","DeepSeek",null,"1.14","4.56","0.0228",null],["text","grok-3-mini-beta","grok-3-mini-beta","SpaceXAI",null,"1.25","2.5","0.2",null],["text","mistral-small-2506","mistral-small-2506","Mistral",null,"0.1","0.3",null,null],["text","intellect-3","intellect-3","",null,"0.2","1.1",null,null],["text","command-a-03-2025","command-a-03-2025","Cohere",null,"2.5","10",null,null],["text","gemini-2.0-flash-lite-preview-02-05","gemini-2.0-flash-lite-preview-02-05","Google",null,"0.075","0.3","0.0375",null],["text","glm-4.5v","glm-4.5v","Z.ai",null,"0.6","1.8",null,null],["text","gpt-oss-120b","gpt-oss-120b","OpenAI",null,"0.15","0.6","0.075",null],["text","gemini-1.5-pro-002","gemini-1.5-pro-002","Google",null,"3.5","10.5",null,null],["text","step-3","step-3","StepFun",null,"0.57","1.42",null,null],["text","o3-mini","o3-mini","OpenAI",null,"0.55","2.2",null,null],["text","llama-3.1-nemotron-ultra-253b-v1","llama-3.1-nemotron-ultra-253b-v1","Nvidia",null,"0.6","1.8",null,null],["text","qwen3-32b","qwen3-32b","Alibaba",null,"0.08","0.28",null,"0.1"],["text","gpt-4o-2024-05-13","gpt-4o-2024-05-13","OpenAI",null,"5","15",null,null],["text","qwen-plus-0125","qwen-plus-0125","Alibaba",null,"0.4","1.2",null,"0.5"],["text","mercury-2","mercury-2","Inception AI",null,"0.25","0.75","0.025",null],["text","minimax-m2","minimax-m2","MiniMax",null,"0.3","1.2",null,null],["text","claude-3-5-sonnet-20240620","claude-3-5-sonnet-20240620","Anthropic",null,"3","15","0.3","3.75"],["text","nvidia-llama-3.3-nemotron-super-49b-v1.5","nvidia-llama-3.3-nemotron-super-49b-v1.5","Nvidia",null,"0.1","0.4",null,null],["text","gemma-3-12b-it","gemma-3-12b-it","Google",null,"0.05","0.15",null,null],["text","gpt-5-nano-high","gpt-5-nano-high","OpenAI","high","0.025","0.2",null,null],["text","o1-mini","o1-mini","OpenAI",null,"1.1","4.4",["0.275","0.55"],null],["text","grok-2-2024-08-13","grok-2-2024-08-13","SpaceXAI",null,"2","10",["0.1","0.2"],"2.5"],["text","qwq-32b","qwq-32b","Alibaba",null,"0.5","1",null,"0.625"],["text","gpt-4o-2024-08-06","gpt-4o-2024-08-06","OpenAI",null,"2.5","10","1.25",null],["text","llama-3.1-405b-instruct-bf16","llama-3.1-405b-instruct-bf16","Meta",null,"4","4",null,null],["text","nova-2-lite","nova-2-lite","Amazon",null,"0.3","2.5",null,null],["text","llama-3.1-405b-instruct-fp8","llama-3.1-405b-instruct-fp8","Meta",null,"4","4",null,null],["text","olmo-3.1-32b-instruct","olmo-3.1-32b-instruct","Ai2",null,"0.2","0.6",null,null],["text","llama-4-maverick-17b-128e-instruct","llama-4-maverick-17b-128e-instruct","Meta",null,"0.63","1.8",null,null],["text","qwen3-30b-a3b","qwen3-30b-a3b","Alibaba",null,"0.12","0.5",null,"0.15"],["text","claude-3-5-haiku-20241022","claude-3-5-haiku-20241022","Anthropic",null,"1","5","0.1","1.25"],["text","gpt-4-turbo-2024-04-09","gpt-4-turbo-2024-04-09","OpenAI",null,"10","30",null,null],["text","gemini-1.5-pro-001","gemini-1.5-pro-001","Google",null,"3.5","10.5",null,null],["text","gpt-4.1-nano-2025-04-14","gpt-4.1-nano-2025-04-14","OpenAI",null,"0.1","0.4",null,null],["text","claude-3-opus-20240229","claude-3-opus-20240229","Anthropic",null,"15","75","1.5","18.75"],["text","molmo-2-8b","molmo-2-8b","Ai2",null,"0.2","0.2",null,null],["text","llama-4-scout-17b-16e-instruct","llama-4-scout-17b-16e-instruct","Meta",null,"0.05","0.1",null,null],["text","glm-4-plus","glm-4-plus","Z.ai",null,"0.44","1.76",null,null],["text","qwen-max-0919","qwen-max-0919","Alibaba",null,"1.6","6.4",null,"2"],["text","llama-3.3-70b-instruct","llama-3.3-70b-instruct","Meta",null,"0.22","0.5","0.11",null],["text","gpt-4o-mini-2024-07-18","gpt-4o-mini-2024-07-18","OpenAI",null,"0.15","0.6","0.075",null],["text","gemma-3n-e4b-it","gemma-3n-e4b-it","Google",null,"0.06","0.12","0.03",null],["text","gpt-oss-20b","gpt-oss-20b","OpenAI",null,"0.024","0.112",null,null],["text","mistral-large-2407","mistral-large-2407","Mistral",null,"2","6","0.2",null],["text","nvidia-nemotron-3-nano-30b-a3b-bf16","nvidia-nemotron-3-nano-30b-a3b-bf16","Nvidia",null,"0.06","0.24",null,null],["text","gpt-4-0125-preview","gpt-4-0125-preview","OpenAI",null,"10","30",null,null],["text","gpt-4-1106-preview","gpt-4-1106-preview","OpenAI",null,"10","30",null,null],["text","gemini-1.5-flash-002","gemini-1.5-flash-002","Google",null,"0.075","0.3","0.0375",null],["text","grok-2-mini-2024-08-13","grok-2-mini-2024-08-13","SpaceXAI",null,"2","10",["0.1","0.2"],"2.5"],["text","olmo-3-32b-think","olmo-3-32b-think","Ai2",null,"0.15","0.5","0.03",null],["text","mercury","mercury","Inception AI",null,"0.25","0.75",["0.025","0.12"],null],["text","mistral-large-2411","mistral-large-2411","Mistral",null,"2","6","0.2",null],["text","magistral-medium-2506","magistral-medium-2506","Mistral",null,"2","5",null,null],["text","granite-4.1-8b","granite-4.1-8b","IBM",null,"0.05","0.1",null,null],["text","gemma-3-4b-it","gemma-3-4b-it","Google",null,"0.05","0.1",null,null],["text","qwen2.5-72b-instruct","qwen2.5-72b-instruct","Alibaba",null,"1.2","1.2",null,"1.5"],["text","mistral-small-3.1-24b-instruct-2503","mistral-small-3.1-24b-instruct-2503","Mistral",null,"0.1","0.3",null,null],["text","llama-3.1-nemotron-70b-instruct","llama-3.1-nemotron-70b-instruct","Nvidia",null,"1.2","1.2",null,null],["text","llama-3.1-70b-instruct","llama-3.1-70b-instruct","Meta",null,"0.4","0.4",null,null],["text","solace","granite-4.2-8b","IBM",null,"0.06","0.25","0.015",null],["text","amazon-nova-pro-v1.0","amazon-nova-pro-v1.0","Amazon",null,"0.8","3.2",null,null],["text","gemma-2-27b-it","gemma-2-27b-it","Google",null,"0.65","0.65",null,null],["text","jamba-1.5-large","jamba-1.5-large","",null,"2","8","0.5",null],["text","gpt-4-0314","gpt-4-0314","OpenAI",null,"30","60",null,null],["text","olmo-3.1-32b-think","olmo-3.1-32b-think","Ai2",null,"0.15","0.5","0.03",null],["text","gemini-1.5-flash-001","gemini-1.5-flash-001","Google",null,"0.075","0.3","0.0375",null],["text","claude-3-sonnet-20240229","claude-3-sonnet-20240229","Anthropic",null,"3","15","0.3","3.75"],["text","gemma-2-9b-it-simpo","gemma-2-9b-it-simpo","",null,"0.03","0.09",null,null],["text","llama-3-70b-instruct","llama-3-70b-instruct","Meta",null,"0.51","0.74",null,null],["text","command-r-plus-08-2024","command-r-plus-08-2024","Cohere",null,"2.5","10",null,null],["text","gpt-4-0613","gpt-4-0613","OpenAI",null,"30","60",null,null],["text","mistral-small-24b-instruct-2501","mistral-small-24b-instruct-2501","Mistral",null,"0.05","0.08",null,null],["text","qwen2.5-coder-32b-instruct","qwen2.5-coder-32b-instruct","Alibaba",null,"0.87","0.87",null,"1.0875"],["text","c4ai-aya-expanse-32b","c4ai-aya-expanse-32b","Cohere",null,"0.5","1.5","0.05",null],["text","gemma-2-9b-it","gemma-2-9b-it","Google",null,"0.03","0.09",null,null],["text","deepseek-coder-v2","deepseek-coder-v2","DeepSeek",null,"0.14","0.28","0.0028",null],["text","qwen2-72b-instruct","qwen2-72b-instruct","Alibaba",null,"0.9","0.9",null,"1.125"],["text","command-r-plus","command-r-plus","Cohere",null,"3","15","0.3","3.75"],["text","claude-3-haiku-20240307","claude-3-haiku-20240307","Anthropic",null,"0.25","1.25",null,"0.3125"],["text","amazon-nova-lite-v1.0","amazon-nova-lite-v1.0","Amazon",null,"0.06","0.24",null,null],["text","gemini-1.5-flash-8b-001","gemini-1.5-flash-8b-001","Google",null,"0.075","0.3","0.0375",null],["text","phi-4","phi-4","Microsoft",null,"0.07","0.14",null,null],["text","olmo-2-0325-32b-instruct","olmo-2-0325-32b-instruct","Ai2",null,"0.05","0.2",null,null],["text","command-r-08-2024","command-r-08-2024","Cohere",null,"0.15","0.6",null,null],["text","mistral-large-2402","mistral-large-2402","Mistral",null,"8","24",null,null],["text","amazon-nova-micro-v1.0","amazon-nova-micro-v1.0","Amazon",null,"0.035","0.14",null,null],["text","jamba-1.5-mini","jamba-1.5-mini","",null,"0.2","0.4",null,null],["text","ministral-8b-2410","ministral-8b-2410","Mistral",null,"0.1","0.1",null,null],["text","gemini-pro-dev-api","gemini-pro-dev-api","Google",null,"0.35","1.05",null,null],["text","mixtral-8x22b-instruct-v0.1","mixtral-8x22b-instruct-v0.1","Mistral",null,"0.9","0.9",null,null],["text","command-r","command-r","Cohere",null,"0.15","0.6",null,null],["text","gpt-3.5-turbo-0125","gpt-3.5-turbo-0125","OpenAI",null,"0.5","1.5",null,null],["text","llama-3-8b-instruct","llama-3-8b-instruct","Meta",null,"0.14","0.14",null,null],["text","gemini-pro","gemini-pro","Google",null,"0.35","1.05",null,null],["text","mistral-medium","mistral-medium","Mistral","medium","1.5","7.5",null,null],["text","llama-3.1-8b-instruct","llama-3.1-8b-instruct","Meta",null,"0.05","0.08",null,null],["text","gpt-3.5-turbo-1106","gpt-3.5-turbo-1106","OpenAI",null,"1","2",null,null],["text","phi-3-medium-4k-instruct","phi-3-medium-4k-instruct","Microsoft",null,"0.17","0.68",null,null],["text","mixtral-8x7b-instruct-v0.1","mixtral-8x7b-instruct-v0.1","Mistral",null,"0.63","0.63",null,null],["text","dbrx-instruct-preview","dbrx-instruct-preview","",null,"0.6","0.6",null,null],["text","qwen1.5-14b-chat","qwen1.5-14b-chat","Alibaba",null,"0.3","0.3",null,"0.375"],["text","internlm2_5-20b-chat","internlm2_5-20b-chat","",null,"0","0",null,null],["text","yi-34b-chat","yi-34b-chat","",null,"0.9","0.9",null,null],["text","openchat-3.5","openchat-3.5","",null,"0.2","0.2",null,null],["text","gemma-1.1-7b-it","gemma-1.1-7b-it","Google",null,"0.03","0.09",null,null],["text","openhermes-2.5-mistral-7b","openhermes-2.5-mistral-7b","",null,"0.17","0.17",null,null],["text","vicuna-33b","vicuna-33b","",null,"0","0",null,null],["text","phi-3-small-8k-instruct","phi-3-small-8k-instruct","Microsoft",null,"0.15","0.6",["0.015","0.075"],null],["text","llama-2-70b-chat","llama-2-70b-chat","Meta",null,"0.7","2.8",null,null],["text","llama-3.2-3b-instruct","llama-3.2-3b-instruct","Meta",null,"0.05","0.33",null,null],["text","nous-hermes-2-mixtral-8x7b-dpo","nous-hermes-2-mixtral-8x7b-dpo","",null,"0.9","0.9",null,null],["text","qwq-32b-preview","qwq-32b-preview","Alibaba",null,"0.5","1",null,"0.625"],["text","solar-10.7b-instruct-v1.0","solar-10.7b-instruct-v1.0","",null,"0.3","0.3",null,null],["text","dolphin-2.2.1-mistral-7b","dolphin-2.2.1-mistral-7b","",null,"0.5","0.5",null,null],["text","wizardlm-13b","wizardlm-13b","Microsoft",null,"0.3","0.3",null,null],["text","mistral-7b-instruct-v0.2","mistral-7b-instruct-v0.2","Mistral",null,"0.2","0.2",null,null],["text","qwen1.5-7b-chat","qwen1.5-7b-chat","Alibaba",null,"0.2","0.2",null,"0.25"],["text","phi-3-mini-4k-instruct-june-2024","phi-3-mini-4k-instruct-june-2024","Microsoft",null,"0.13","0.52",null,null],["text","vicuna-13b","vicuna-13b","",null,"0.3","0.3",null,null],["text","llama-2-13b-chat","llama-2-13b-chat","Meta",null,"0.25","0.25",null,null],["text","palm-2","palm-2","Google",null,"0.5","0.5",null,null],["text","gemma-7b-it","gemma-7b-it","Google",null,"0.05","0.08",null,null],["text","codellama-34b-instruct","codellama-34b-instruct","Meta",null,"0.35","1.4",null,null],["text","zephyr-7b-beta","zephyr-7b-beta","",null,"0.15","0.15","0.015",null],["text","phi-3-mini-128k-instruct","phi-3-mini-128k-instruct","Microsoft",null,"0.13","0.52",null,null],["text","phi-3-mini-4k-instruct","phi-3-mini-4k-instruct","Microsoft",null,"0.13","0.52",null,null],["text","stripedhyena-nous-7b","stripedhyena-nous-7b","",null,"0.2","0.2",null,null],["text","codellama-70b-instruct","codellama-70b-instruct","Meta",null,"0.7","2.8",null,null],["text","vicuna-7b","vicuna-7b","",null,"0.2","0.2",null,null],["text","llama-3.2-1b-instruct","llama-3.2-1b-instruct","Meta",null,"0.027","0.201",null,null],["text","mistral-7b-instruct","mistral-7b-instruct","Mistral",null,"0.07","0.28",null,null],["text","llama-2-7b-chat","llama-2-7b-chat","Meta",null,"0.15","0.15","0.015",null],["text","gemma-2b-it","gemma-2b-it","Google",null,"0.1","0.1",null,null],["text","qwen1.5-4b-chat","qwen1.5-4b-chat","Alibaba",null,"0.1","0.1",null,"0.125"],["text","olmo-7b-instruct","olmo-7b-instruct","Ai2",null,"0.2","0.2",null,null],["text","llama-13b","llama-13b","Meta",null,"0.225","0.225",null,null]],"droppedNonFinite":0};

  const __IDENTIFY_BUILD__ = {
    "generatedBy": "tools/build-userscript.mjs",
    "ruleVersion": "identify-rules-v1",
    "kernelSource": "src/identify-core.mjs",
    "kernelHash": "1fe2bbf7849e8ffbad8a74b5ea4efad0d7977999bc15dc0c99593bc24f1a03f1",
    "kernelBytes": 42825,
    "bundleSource": "data/arena-models-derived.json",
    "bundleHash": "6cee163797e57b24f0f86ab215e7bbb461cb935006be45efb6be1b02f21993f6",
    "bundleBytes": 36683,
    "catalogRows": 466,
    "pricedRows": 366,
    "unpricedRows": 100,
    "scriptVersion": "0.6.6"
  };

// ═══════════════════════════════════════════════════════════════════════════
  // 识别胶水层（与上面的 kernel、bundle 同处一个 __IDENTIFY_BLOCK__ 区域）
  //
  // 这一段是**纯函数**：不碰 DOM、不碰 window、不发请求。它由 tools/build-userscript.mjs
  // 与 kernel、bundle 一起拼进单文件脚本；parity 测试会把整段抽出来单独求值，
  // 用同一份 fixture 与 CLI（node tools/identify-session.mjs --json）逐字节比对。
  //
  // 唯一的例外在**文件末尾**：identifyHookNamespace() 负责把 identifyPolicy 补挂到公开命名空间
  // __ARENA_AGENT_BILLING__.identify.policy（详见那里的注释）；它不是判定逻辑的一部分，
  // 在非浏览器环境（parity 把整块抽出来 new Function 求值）里完全不执行。
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 压缩 bundle → 内核要的目录行数组。
   *
   * 无价行只内嵌了一个计数：这里补出等量的占位行（prices 全 null），
   * 让内核 report.ignored.unpricedRows 与 boundary 里的
   * 「目录 N 行中 M 行没有 in/out 价」与读完整目录的 CLI 逐字一致。
   * 占位行的 key（__unpriced__/i）不会出现在 report 的任何字段里
   * （内核只用 unpriced 数组的长度，见 identify-core.mjs 的 report.ignored）。
   */
  function identifyBundleCatalog(bundle) {
    const rows = [];
    for (const r of bundle.rows) {
      rows.push({
        arena: r[0],
        key: r[1],
        disp: r[2],
        org: r[3],
        tier: r[4],
        prices: { input: r[5], output: r[6], cacheRead: r[7], cacheWrite: r[8] },
      });
    }
    for (let i = 0; i < bundle.unpricedRows; i++) {
      rows.push({
        arena: null,
        key: '__unpriced__/' + i,
        disp: '',
        org: null,
        tier: null,
        prices: { input: null, output: null, cacheRead: null, cacheWrite: null },
      });
    }
    return rows;
  }

  const IDENTIFY_CATALOG = identifyBundleCatalog(__IDENTIFY_BUNDLE__);

  /** /cost 响应（已 JSON.parse）⇒ 冻结形状 report。与 CLI 同一个内核、同一份目录语义。 */
  function identifyReport(costJson) {
    return identifyFromCost({ costJson, catalog: IDENTIFY_CATALOG });
  }

  /** 目录里与该价向量同价的模型（目录级同价碰撞组，来自内嵌 bundle）。 */
  function identifyCatalogGroup(vectorKey) {
    const groups = __IDENTIFY_BUNDLE__.vectorGroups || [];
    for (const g of groups) if (g.vectorKey === vectorKey) return g.keys;
    return null;
  }

  function identifyShortHash(h) {
    return String(h || '').slice(0, 16) + '…';
  }

  const IDENTIFY_SENSITIVE_KEY = /^(?:cookie|cookies|set-cookie|authorization|auth|token|access_token|refresh_token|session_token|id_token|api_?key|secret|password|passwd|credential|credentials|bearer|prompt|prompts|completion|content|contents|text|body|html|transcript|message_?text)$/i;

  /**
   * 导出前的脱敏：**递归结构保持**，只删名字命中敏感词表的键，其余原样保留。
   *
   * 为什么用"删键"而不是"白名单挑字段"：/cost 响应的字段名里带 token 的
   * （inputTokensCostUsd 等）恰恰是**要保留的计费数据**，白名单/正则黑名单都容易误伤；
   * 这里改成对**键名整体匹配**敏感词，计费字段名不在表内 ⇒ 一个都不会被删。
   * 实测（test/run-userscript-parity-tests.mjs）：真实 fixture 上 removed 为空，
   * 导出的就是服务端原文；带 cookie/token/prompt/content/text/body 的构造输入全部被剔除。
   */
  function sanitizeCostForExport(root) {
    const removed = [];
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.map((v, i) => walk(v, path + '[' + i + ']'));
      if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
          if (IDENTIFY_SENSITIVE_KEY.test(k)) { removed.push(path + '.' + k); continue; }
          out[k] = walk(v, path + '.' + k);
        }
        return out;
      }
      return node;
    };
    return { json: walk(root, '$'), removed };
  }

  /**
   * 导出文本：未剔除任何键 ⇒ 直接落服务端原文（逐字节）；剔除了 ⇒ 落脱敏后的重序列化。
   * 文件名只带会话前缀与时间戳，不含任何内容。
   */
  function buildCostExportText(src) {
    const clean = sanitizeCostForExport(src.json);
    const text = clean.removed.length ? JSON.stringify(clean.json, null, 2) + '\n' : src.text;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    return {
      text,
      removed: clean.removed,
      name: `arena-cost-${String(src.sid).slice(0, 8)}-${stamp}.json`,
    };
  }

  /**
   * report ⇒ 面板文本（纯函数，便于用最小 DOM 桩/纯调用做断言）。
   * 必须同时给出：完整候选 / 未约束候选（分开）/ 同价碰撞组 / 已忽视无价行数 /
   * 长上下文受限提示 / KERNEL_HASH 与 RULE_VERSION / 边界声明（候选 ≠ 身份已证明）。
   */
  function renderIdentifyText(report) {
    const b = __IDENTIFY_BUILD__;
    const bundle = __IDENTIFY_BUNDLE__;
    const L = [];
    const MAX_LIST = 12;

    L.push('判定 ' + report.verdict);
    L.push('消息：非长上下文 ' + report.regime.standardMessages + ' 条 / 长上下文 ' + report.regime.longContextMessages +
      ' 条（长上下文规则 ' + report.regime.longContextRule + '）');
    L.push('内核 KERNEL_HASH=' + identifyShortHash(b.kernelHash) + '  RULE_VERSION=' + b.ruleVersion);
    L.push('目录 BUNDLE_HASH=' + identifyShortHash(b.bundleHash) + '  有价行 ' + bundle.pricedRows +
      ' / 无价行 ' + bundle.unpricedRows + '（目录共 ' + bundle.catalogRows + ' 行）');
    L.push('已忽视 ' + report.ignored.unpricedRows + ' 条无价目录行（' + report.ignored.note + '）');
    if (report.regime.longContextMessages > 0) {
      L.push('⚠ 长上下文计价规则未知，本会话判定受限：' + report.regime.longContextMessages +
        ' 条长上下文消息按规则 6 不参与判定（归 T3）。');
    }
    if (report.verdict === 'INSUFFICIENT-OBSERVATION') {
      L.push('（本次响应里没有非长上下文消息 ⇒ 只能给 INSUFFICIENT-OBSERVATION，不做任何候选声明）');
    }

    L.push('');
    L.push('— 完整验证候选（' + report.complete.length + '）—');
    if (!report.complete.length) L.push('  （无：当前目录与观测无法同时解释，见下方边界声明）');
    for (const c of report.complete.slice(0, MAX_LIST)) {
      const vk = priceVectorKey(c.prices);
      L.push('  · ' + c.disp + '  [' + (c.org || '?') + (c.tier ? ' / ' + c.tier : '') + ']  ref=' + c.refVersion);
      L.push('      ' + c.key);
      L.push('      价向量 ' + vk + '  in=' + c.prices.input + ' out=' + c.prices.output +
        ' cr=' + c.prices.cacheRead + ' cw=' + c.prices.cacheWrite);
      for (const id of c.messages) {
        const t = c.impliedTokens[id];
        // 用**完整** message id：本 fixture 里 01a123ea-e490 / 01a123ea-1e8d 前 8 位相同，
        // 截断会显示成两条一模一样的行（歧义），技术面板可滚动，宁长不糊。
        if (t) L.push('      反解 token ' + id + ' in=' + t.in + ' out=' + t.out + ' cr=' + t.cr + ' cw=' + t.cw);
      }
      const group = identifyCatalogGroup(vk);
      const sameVector = report.collisions.find((k) => k.vectorKey === vk);
      if (sameVector && sameVector.models.length > 1) {
        L.push('      ⚠ 同价碰撞：' + sameVector.models.length + ' 个模型同为该价向量 ⇒ 本次不可区分：' +
          sameVector.models.filter((k) => k !== c.key).join('、'));
      }
      if (group && group.length > sameVector?.models.length) {
        L.push('      ⚠ 目录同价组另有 ' + (group.length - (sameVector ? sameVector.models.length : 1)) +
          ' 个未进完整候选的同价模型：' + group.filter((k) => !report.complete.some((x) => x.key === k)).join('、'));
      }
    }
    if (report.complete.length > MAX_LIST) L.push('  …另有 ' + (report.complete.length - MAX_LIST) + ' 条');
    if (report.complete.length > 1) {
      L.push('  ⚠ 以上 ' + report.complete.length + ' 条均为"完整验证候选"，彼此不可区分；' +
        '本批 input 费用恒为 0 ⇒ 输入单价无约束（任何 p_in 都能通过），不允许只挑其中一条当结论。');
    }

    L.push('');
    L.push('— 未约束候选（' + report.unconstrained.length + '，未确认，不许当成通过）—');
    if (!report.unconstrained.length) L.push('  （无）');
    for (const u of report.unconstrained.slice(0, MAX_LIST)) L.push('  · ' + u.disp + '  [' + u.reason + ']  ' + u.key);
    if (report.unconstrained.length > MAX_LIST) L.push('  …另有 ' + (report.unconstrained.length - MAX_LIST) + ' 条');

    L.push('');
    L.push('— 同价碰撞组（' + report.collisions.length + '）—');
    if (!report.collisions.length) L.push('  （无）');
    for (const g of report.collisions) L.push('  ' + g.vectorKey + ' ⇒ ' + g.models.join('、'));

    L.push('');
    L.push('— 边界声明 —');
    for (const s of report.boundary) L.push('  · ' + s);
    return L.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 判定策略适配器（**候选池成员关系**口径）—— 纯函数：零 DOM / 零网络 / 零 node 依赖 / 零全局可变状态
  //
  // 用户口径（原话）：「我说的不是不确定就不要，我是说**判断不出来就不要，就是不在我们的那个
  // 候选池里面就不要**……一般模型差不多就可以了，差不多我就会用。」
  // ⇒ 判定 = **成员关系**：H = complete ∩ poolKeys（按目录行 key）非空 ⇒ 保留；
  //    有可验证候选但都不在池里 ⇒ 归档。
  //    ★ R1（用户 2026-10-11）：**「根本验证不出来（没有费用证据）」不再归档，改为暂停**
  //    —— 无证据 ≠ 费用为 0，也 ≠ 判不出来。只有拿着有效证据判出「对不上名单」才归档。
  //    不要求唯一、不设占比阈值；长上下文不否决；unconstrained 不阻断（只标注）。
  //
  // 上一版（严格门槛：要求候选唯一、要求未约束候选为 0、要求无长上下文）是对需求的误读，
  // 那一段已**整段删除**（含它的三张表与判定函数）：本文件里不再存在这三类否决中的任何一类，
  // 也不再有旧口径的任何标识符 —— 旧口径的三个判定名在代码与注释里都是零出现（grep 可证）。
  //
  // 诚实边界：POOL_HIT 只表示「费用证据与池内候选**兼容**」，**不代表已确认实际模型身份**；
  // POOL_MISS **不许**写成「已确认实际模型不在池内」（存在 unconstrained 候选时尤其如此）。
  // Arena 官方说明同一会话可能因可靠性回退切换模型 ⇒ 历史命中不是永久保证。
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ★ 判定表（**唯一事实来源**）：严格按优先级从上到下，先命中先返回。
   *
   *   POOL_INVALID     → PAUSE   候选池配置无效，请重新选择
   *   POOL_EMPTY       → PAUSE   请先选择候选池
   *   EVIDENCE_PENDING → WAIT    等待费用证据
   *   NO_EVIDENCE      → PAUSE   判不出来：未取得有效费用证据（★ 不归档，见下）
   *   NO_COMPLETE      → ARCHIVE 判不出来：无可验证候选
   *   POOL_MISS        → ARCHIVE 可验证候选未命中当前池
   *   POOL_HIT         → KEEP    候选池命中：{命中名称列表}
   *
   * ★★ 口径变更（用户 2026-10-11 权威裁定，卡 I′ 落地）：**旧 `NO_EVIDENCE → ARCHIVE` 作废**。
   *   用户原话：「一旦没有生成费用，就说明出现了 bug（我们本来就是靠费用反推的）……
   *   那就可以停止了，再复生对话是没有用的」，以及「至少要等费用出来才能判断」。
   *   ⇒ 无费用证据是**观测缺失**，不是「费用=0」，更不是「判不出来 ⇒ 归档」；
   *     确证终态仍取不到证据时只能**暂停 + 停止自动推进**（不归档、不再排队新探针、不新建会话）。
   *   （NO_COMPLETE / POOL_MISS 仍是 ARCHIVE：它们有**有效证据**，只是候选对不上名单。）
   *
   * 判定顺序**只在这里写一次**（不在函数体里散写 if/else 链）：
   * IDENTIFY_POLICY_PRIORITY 与 IDENTIFY_POLICY_DECISIONS 都由本表派生 ⇒ "顺序"只有一份事实来源。
   * 每条规则只读 ctx（= 已经归一化的池配置 + 证据），不碰任何外部状态。
   */
  const IDENTIFY_POLICY_RULES = Object.freeze([
    // ① 池配置无效：poolKeys 类型畸形 / 池里有非字符串 key / 目录版本（哈希）与运行时不一致 /
    //    给了 knownCatalogKeys 而池里有目录里不存在的 key。池本身不可信时，拿它比任何证据都是错的。
    Object.freeze({ reason: 'POOL_INVALID', decision: 'PAUSE', hit: (c) => c.poolInvalid }),
    // ② 池为空（poolKeys 是 null/undefined，或空数组）：没有可比的目标 ⇒ 让用户先选池，而不是归档会话。
    //    空数组走这里，**不是** POOL_INVALID（任务书明确）；"池里有未知 key"才走 ①。
    Object.freeze({ reason: 'POOL_EMPTY', decision: 'PAUSE', hit: (c) => c.poolEmpty }),
    // ③ 证据还没到齐（report 缺失/非法/费用未结算）且只读重取尚未结束 ⇒ 等下一轮再判。
    Object.freeze({ reason: 'EVIDENCE_PENDING', decision: 'WAIT', hit: (c) => !c.evidenceOk && !c.evidenceFinal }),
    // ④ 只读重取已耗尽（evidenceFinal === true）仍无有效证据 ⇒ **判不出来，暂停**（不归档）。
    //    ★★ R1（用户 2026-10-11 权威口径，作废旧 NO_EVIDENCE→ARCHIVE）：无费用证据 = 观测缺失，
    //    不得据此判定命中/完成，也不得用「费用=0」代替；调用方收到 PAUSE 必须停下自动推进
    //    （不归档当前会话、不排队新探针、不新建会话），交人工确认。
    Object.freeze({ reason: 'NO_EVIDENCE', decision: 'PAUSE', hit: (c) => !c.evidenceOk }),
    // ⑤ 有效 report 但 complete 为空 ⇒ 没有可验证候选（长上下文被内核排除后也可能落在这里）。
    Object.freeze({ reason: 'NO_COMPLETE', decision: 'ARCHIVE', hit: (c) => c.completeCount === 0 }),
    // ⑥ complete 非空但 H = complete ∩ poolKeys 为空 ⇒ 可验证候选未命中当前池（措辞见 IDENTIFY_POLICY_MESSAGES）。
    Object.freeze({ reason: 'POOL_MISS', decision: 'ARCHIVE', hit: (c) => c.matchedKeys.length === 0 }),
    // ⑦ H 非空 ⇒ 保留。命中只表示"费用证据与池内候选兼容"，**不代表已确认实际模型身份**。
    Object.freeze({ reason: 'POOL_HIT', decision: 'KEEP', hit: () => true }),
  ]);

  /** 判定优先级（**由规则表派生**，不另写一份，避免两张表漂移）。 */
  const IDENTIFY_POLICY_PRIORITY = Object.freeze(IDENTIFY_POLICY_RULES.map((r) => r.reason));

  /** reason ⇒ decision（同样由规则表派生；返回值的 decision 直接取自命中的那条规则）。 */
  const IDENTIFY_POLICY_DECISIONS = Object.freeze(
    IDENTIFY_POLICY_RULES.reduce((acc, r) => { acc[r.reason] = r.decision; return acc; }, {}),
  );

  /**
   * reason ⇒ 文案（判定表最后一列，面板直接显示；**不掺任何模型身份断言**）。
   *   · POOL_MISS 的措辞固定为"可验证候选未命中当前池"—— **不是**"已确认实际模型不在池内"：
   *     存在 unconstrained 候选时，它们既没被确认、也没被排除。
   *   · POOL_HIT 的 "{命中名称列表}" 由 matchedNames（目录展示名，缺则退回 key）填。
   */
  const IDENTIFY_POLICY_MESSAGES = Object.freeze({
    POOL_INVALID: () => '候选池配置无效，请重新选择',
    POOL_EMPTY: () => '请先选择候选池',
    EVIDENCE_PENDING: () => '等待费用证据',
    NO_EVIDENCE: () => '判不出来：未取得有效费用证据',
    NO_COMPLETE: () => '判不出来：无可验证候选',
    POOL_MISS: () => '可验证候选未命中当前池',
    POOL_HIT: (c) => '候选池命中：' + c.matchedNames.join('、'),
  });

  /**
   * 目录行 key 的比较器：**字典序升序（UTF-16 码元序）**，与内核 report.complete 的
   * `(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)` 同一口径。
   * 于是 matchedKeys 的顺序与"用户在面板上勾选的顺序""report 里的行序"都无关 ⇒ 稳定、可复现。
   */
  function identifyPolicyKeyCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * 把 report 里判定需要的证据读出来并归一化（**只读、绝不抛异常**）。
   *
   * 「有效 report」= 同时满足三项形状（与内核 identifyFromCost 的冻结形状一致）：
   *   ① 非数组对象；② complete 与 unconstrained 都是数组；③ regime 是对象且 longContextMessages
   *   是 ≥0 的有限数。任一项不满足 ⇒ evidenceOk:false（由 ③/④ 兜底成 WAIT 或 PAUSE/NO_EVIDENCE），
   *   但**能读到的计数照实带出**（读不出的才是 0，不猜、不伪造）。
   *
   * ignoredCount = 内核已忽视的**无价目录行**数（report.ignored.unpricedRows）。
   *   注意它与"池里的缺价行"是两回事：池里的缺价行只要被内核反解补齐进 complete，照样能贡献命中。
   */
  function identifyPolicyEvidence(report) {
    const ev = {
      evidenceOk: false,
      completeCount: 0,
      completeRows: [],
      unconstrainedCount: 0,
      ignoredCount: 0,
      longContextMessages: 0,
    };
    if (!report || typeof report !== 'object' || Array.isArray(report)) return ev;
    if (Array.isArray(report.complete)) {
      ev.completeRows = report.complete;
      ev.completeCount = report.complete.length;
    }
    if (Array.isArray(report.unconstrained)) ev.unconstrainedCount = report.unconstrained.length;
    const ign = report.ignored;
    if (ign && typeof ign === 'object' && !Array.isArray(ign)) {
      const u = ign.unpricedRows;
      if (typeof u === 'number' && Number.isFinite(u) && u >= 0) ev.ignoredCount = u;
    }
    const regime = report.regime;
    const hasRegime = !!regime && typeof regime === 'object' && !Array.isArray(regime);
    const lc = hasRegime ? regime.longContextMessages : null;
    const hasLc = typeof lc === 'number' && Number.isFinite(lc) && lc >= 0;
    if (hasLc) ev.longContextMessages = lc;
    // 三项必备形状缺一 ⇒ 保持 evidenceOk:false（WAIT / NO_EVIDENCE 兜底），但上面的计数照实带出。
    if (!Array.isArray(report.complete) || !Array.isArray(report.unconstrained) || !hasLc) return ev;
    ev.evidenceOk = true;
    return ev;
  }

  /**
   * 池配置归一化（**只读、绝不抛异常**）。返回 { invalid, empty, keys }。
   *
   *   · poolKeys 为 null/undefined                 ⇒ empty（"还没选池"，让用户去选；不是配置无效）
   *   · poolKeys 非数组 / 元素不是非空字符串        ⇒ invalid（畸形配置）
   *   · poolCatalogHash 与 runningCatalogHash **都非空**且不等 ⇒ invalid（池是用旧目录版本选的）
   *   · 给了 knownCatalogKeys（数组）且池里有表外 key ⇒ invalid（未知目录行）
   *   · 其余（含 poolKeys: []）                     ⇒ empty
   *
   * invalid 优先于 empty（与判定表顺序一致）：池整体不可信时先让用户重选，而不是提示"请选池"。
   * 空池**不会**因为 knownCatalogKeys 而变 invalid（没有 key 可校验）⇒ 空数组是 POOL_EMPTY。
   * keys 去重后返回（重复勾选不改变语义）；命中列表另有固定排序，与本数组顺序无关。
   */
  function identifyPolicyPool(opts) {
    const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    const raw = o.poolKeys;
    const out = { invalid: false, empty: false, keys: [] };
    if (raw === null || raw === undefined) { out.empty = true; return out; }
    if (!Array.isArray(raw)) { out.invalid = true; return out; }
    const seen = new Set();
    for (const k of raw) {
      if (typeof k !== 'string' || !k) { out.invalid = true; return out; }
      if (!seen.has(k)) { seen.add(k); out.keys.push(k); }
    }
    const hashOf = (v) => (typeof v === 'string' && v.trim() ? v : null);
    const poolHash = hashOf(o.poolCatalogHash);
    const runHash = hashOf(o.runningCatalogHash);
    if (poolHash && runHash && poolHash !== runHash) { out.invalid = true; return out; }
    const known = o.knownCatalogKeys;
    if (known !== null && known !== undefined) {
      if (!Array.isArray(known)) { out.invalid = true; return out; }
      const allowed = new Set(known.filter((k) => typeof k === 'string' && k));
      if (out.keys.some((k) => !allowed.has(k))) { out.invalid = true; return out; }
    }
    if (!out.keys.length) out.empty = true;
    return out;
  }

  /**
   * 候选池成员关系判定（**纯函数**：只用入参，不读 DOM、不发请求、不依赖全局可变状态、绝不抛异常）。
   *
   * @param {object} report 内核 identifyFromCost() 的 report（面板与 CLI 逐字节相同的那一份）
   * @param {object} opts   { poolKeys, poolCatalogHash, runningCatalogHash, knownCatalogKeys, evidenceFinal }
   * @returns {{decision:'KEEP'|'ARCHIVE'|'WAIT'|'PAUSE', reason:string, matchedKeys:string[],
   *            completeCount:number, unconstrainedCount:number, ignoredCount:number,
   *            limitations:string[], message:string}}
   *
   *   · decision / reason / matchedKeys / completeCount / unconstrainedCount / ignoredCount / limitations
   *     是**冻结契约**（卡 B′/D′ 依赖这七个字段）；message 是判定表最后一列「文案」的落点（附加字段，
   *     面板可直接显示；不需要的调用方忽略即可）。
   *   · matchedKeys 是**完整**命中列表（面板要展开显示）：去重、按目录行 key 字典序升序（口径见
   *     identifyPolicyKeyCompare），与池顺序、report 行序无关。池不可用（PAUSE）时为 []。
   *   · limitations 只描述"真正基于证据判定"的分支（NO_COMPLETE / POOL_MISS / POOL_HIT）：
   *     UNCONSTRAINED_PRESENT（存在未约束候选，**只展示、永不参与命中**）、
   *     LONG_CONTEXT_EXCLUDED（有长上下文记录被内核按规则 6 排除，**不再一票否决**）。
   *     证据形状不全（WAIT / NO_EVIDENCE）或池不可用（PAUSE）⇒ []。
   *   · evidenceFinal 只认严格 true：只有"只读重取确实已结束"才把 WAIT 降级成
   *     **PAUSE/NO_EVIDENCE（不归档 —— R1 口径，用户 2026-10-11）**。
   */
  function identifyPolicy(report, opts) {
    const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    const pool = identifyPolicyPool(o);
    const ev = identifyPolicyEvidence(report);
    const evidenceFinal = o.evidenceFinal === true;
    const matchedKeys = [];
    const matchedNames = [];
    if (!pool.invalid && !pool.empty) {
      const poolSet = new Set(pool.keys);
      const seen = new Set();
      const hits = [];
      for (const row of ev.completeRows) {
        const key = row && typeof row === 'object' && !Array.isArray(row) ? row.key : null;
        if (typeof key !== 'string' || !key || seen.has(key) || !poolSet.has(key)) continue;
        seen.add(key);
        hits.push({ key, name: typeof row.disp === 'string' && row.disp ? row.disp : key });
      }
      hits.sort((a, b) => identifyPolicyKeyCompare(a.key, b.key));
      for (const h of hits) { matchedKeys.push(h.key); matchedNames.push(h.name); }
    }
    const limitations = [];
    if (ev.evidenceOk && !pool.invalid && !pool.empty) {
      if (ev.unconstrainedCount > 0) limitations.push('UNCONSTRAINED_PRESENT');
      if (ev.longContextMessages > 0) limitations.push('LONG_CONTEXT_EXCLUDED');
    }
    const ctx = {
      poolInvalid: pool.invalid,
      poolEmpty: pool.empty,
      evidenceOk: ev.evidenceOk,
      evidenceFinal,
      completeCount: ev.completeCount,
      unconstrainedCount: ev.unconstrainedCount,
      ignoredCount: ev.ignoredCount,
      longContextMessages: ev.longContextMessages,
      matchedKeys,
      matchedNames,
      limitations,
    };
    let rule = IDENTIFY_POLICY_RULES[IDENTIFY_POLICY_RULES.length - 1];   // 兜底 = 最后一条（POOL_HIT，必然终止）
    for (const r of IDENTIFY_POLICY_RULES) { if (r.hit(ctx)) { rule = r; break; } }
    return {
      decision: rule.decision,
      reason: rule.reason,
      matchedKeys,
      completeCount: ev.completeCount,
      unconstrainedCount: ev.unconstrainedCount,
      ignoredCount: ev.ignoredCount,
      limitations,
      message: IDENTIFY_POLICY_MESSAGES[rule.reason](ctx),
    };
  }

  /**
   * 把 identifyPolicy 挂到公开命名空间上（幂等；返回是否挂上）。
   * 只接受"命名空间对象"一个入参、不自己去找 window ⇒ 本函数本身仍是纯的，测试可直接调。
   */
  function identifyInstallPolicy(ns) {
    if (!ns || typeof ns !== 'object') return false;
    const identify = ns.identify && typeof ns.identify === 'object' ? ns.identify : (ns.identify = {});
    identify.policy = identifyPolicy;
    return identify.policy === identifyPolicy;
  }

  /**
   * 把 identifyPolicy 补到（可能已被别的部件重建过的）命名空间对象上。幂等、不抛、不建 window。
   */
  function identifyReattachPolicy() {
    if (typeof window === 'undefined' || !window) return false;
    try { return identifyInstallPolicy(window.__ARENA_AGENT_BILLING__); } catch (_) { return false; }
  }

  /**
   * 命名空间补挂（**同步路径**）—— 只做一件事：让 __ARENA_AGENT_BILLING__.identify.policy 在
   * bootstrap 之后**同步**可用。
   *
   * 为什么需要这一段：公开命名空间对象是在 parts/60-bootstrap.js 末尾用**对象字面量重建**的
   * （那一段归别的卡，本卡只读它），而本段代码在它之前求值 ⇒ 直接挂会被那次赋值覆盖。
   * 做法：在 window 上装一个**一次性**访问器，拦下 bootstrap 的那一次赋值，把 policy 补进去，
   * 随后立刻换回普通数据属性（写/枚举/可配置，与 bootstrap 原本的语义完全一致）。
   * 装之前先记下已有访问器并**链式转发**（别的部件可能先装了一个，不能把人家的挂载吞掉）。
   * 任何一步失败都不抛：装不上就算了，bootstrap 照原样赋值 —— 补挂绝不拖垮脚本。
   * 非浏览器环境（parity 测试把整块抽出来 new Function 单独求值）没有 window ⇒ 整段不执行。
   */
  function identifyHookNamespace() {
    if (typeof window === 'undefined' || !window) return false;
    try {
      if (window.__ARENA_AGENT_BILLING__) return identifyInstallPolicy(window.__ARENA_AGENT_BILLING__);
      const prev = Object.getOwnPropertyDescriptor(window, '__ARENA_AGENT_BILLING__');
      Object.defineProperty(window, '__ARENA_AGENT_BILLING__', {
        configurable: true,
        enumerable: true,
        get() { return prev && typeof prev.get === 'function' ? prev.get() : undefined; },
        set(ns) {
          if (prev && typeof prev.set === 'function') { try { prev.set(ns); } catch (_) { /* 别的部件的挂载失败不连坐 */ } }
          try { identifyInstallPolicy(ns); } catch (_) { /* 补挂失败不影响 bootstrap */ }
          Object.defineProperty(window, '__ARENA_AGENT_BILLING__', {
            value: ns, writable: true, enumerable: true, configurable: true,
          });
        },
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  identifyHookNamespace();

  /**
   * 顺序无关兜底（**异步路径**）：同一个属性上，本卡之后求值的部件还会再装自己的访问器
   * （例如 parts/32-probe-pool.js 的 probePoolExpose 就装了一个 —— 后装者赢，本卡的同步拦截至此失效）。
   * 所以脚本跑完后再补一次：只要最终那个对象上没有 policy 就挂上。幂等；没有 window 时不执行。
   * 时序诚实说明：命中的是"脚本执行完之后的第一个微任务/定时器"，不是同一轮同步执行；
   * 控制台复核、面板后续逻辑、上层状态机调用都在那之后，因此不受影响。
   */
  if (typeof window !== 'undefined' && window) {
    const reattach = () => { identifyReattachPolicy(); };
    if (typeof queueMicrotask === 'function') queueMicrotask(reattach);
    if (typeof setTimeout === 'function') setTimeout(reattach, 0);
  }
  // __IDENTIFY_BLOCK_END__
  const STORAGE = 'arena-agent-billing:userscript:v2';
  const FLAG_COOKIE = 'ph-toolbar-overrides';
  const MIN_COST_GAP_MS = 4000;
  const PROBE_RETRY_GAP_MS = 6000;
  const DEFAULT_TASK = '请用一句话回答：1+1 等于多少？';
  const DEFAULT_PROBES = ['你好', '请只回答：1+1 等于多少？', '请用一个词回答：春天。', '只回复 OK。'];
  const COST_ROUTE = /\/api\/(?:chat|evaluation)\/([^/?#]+)\/cost/;
  const THOUGHT_TYPE = /(?:reasoning|thinking|thought)[\w-]*/i;
  const HUMAN_VERIFICATION = /(?:captcha|recaptcha|hcaptcha|verify you are human|human verification|人机验证|验证你是人类|请完成验证)/i;

  // 只把价格向量当作“候选类别”证据；同价模型保留碰撞提示，不宣称服务端身份已被证明。
  const CANDIDATES = [
    { model: 'contenders/claude-opus-5.5-high-vertex-agent', label: 'Claude Opus 5.5 (High)', prices: { in: 4, cw: 5, cr: 0.2, out: 20 } },
    { model: 'contenders/gpt-5.6-sol-xhigh-agent', label: 'GPT 5.6 Sol (xHigh)', prices: { in: 4, cw: 5, cr: 0.2, out: 20 } },
    { model: 'contenders/claude-opus-5-high-vertex-agent', label: 'Claude Opus 5 (High)', prices: { in: 5, cw: 6.25, cr: 0.5, out: 25 } },
    { model: 'contenders/claude-opus-5-max-agent', label: 'Claude Opus 5 (Max)', prices: { in: 5, cw: 6.25, cr: 0.5, out: 25 } },
    { model: 'contenders/gpt-6-astra-max-agent', label: 'GPT 6 Astra (Max)', prices: { in: 10, cw: 12.5, cr: 1, out: 50 } },
    { model: 'contenders/claude-fable-5.1-max-agent', label: 'Claude Fable 5.1 (Max)', prices: { in: 10, cw: 12.5, cr: 0.25, out: 50 } },
  ];

  const BILLING_VERSIONS = [
    { id: '2026-10-05/08', i: 2156, w: 2695, r: 100, o: 6468 },
    { id: '2026-10-01', i: 2156, w: 2695, r: 200, o: 12000 },
  ];

  const defaults = {
    target: 'opus',
    rounds: 2,
    probeText: DEFAULT_PROBES.join('\n'),
    tasks: DEFAULT_TASK,
    enabled: false,
  };

  const loaded = readJson(STORAGE, {});
  const config = { ...defaults, ...(loaded.config || {}) };
  // 旧版本只有单条“你好”时自动迁移到可轮换的默认探针组；用户自定义单条提示词保持不变。
  if (loaded.config?.probeText === '你好') config.probeText = defaults.probeText;
  const run = {
    phase: 'IDLE',
    sessionId: null,
    previousSessionId: null,
    owned: false,
    completedRounds: 0,
    pendingRound: 0,
    retries: 0,
    verdict: null,
    lastCost: null,
    reason: null,
    createdAt: null,
    startedAt: null,
    currentRunOwned: [],
    attempt: 0,
    probeIndex: 0,
  };
  let costTimer = null;
  let roundTimer = null;
  let watchTimer = null;
  let probeTimer = null;
  let panel = null;
  let automationToken = 0;
  // 顶部先抓住原生 fetch：installNetworkHooks() 会把 window.fetch 包掉，
  // 而费用读数要用**没被包的**那个，免得自己的只读请求被钩子记进筛选状态。
  // （installNetworkHooks 里那个 const nativeFetch 是函数内作用域，外面看不见。）
  const nativeFetch = window.fetch.bind(window);

  // ═══════════════════════════════════════════════════════════════════════════
  // 固定目标名单（卡 t-mv2j1g19-kkt8dv —— 取代卡 B′ 的「候选池 + 两个开关」）
  //
  // 用户口径（2026-10-10 原话）：「自动归档好像失败了，它不会自动归档。这功能还是太复杂了……
  // 简化一下这个操作：就始终指定那种贵的模型，GPT 6.1、GPT 6 Astra 这些，还有 Claude Opus 5.5、
  // Claude Fable 5.1 这些；其他都不要，其他模型垃圾。」
  //   ⇒ 名单**恒定**（不再有预设多选 / 行级勾选 / 「按候选池固定筛选」开关）；
  //     固定筛选**恒开**（命中即保留；未命中自动归档；**无费用证据则暂停、不归档** —— R1 口径）；
  //     成员资格仍以**目录行 key** 为准；价格向量只用于展示与同价分组，
  //     **绝不**因为同价就把同价的其他 key 拉进名单。
  //
  // ★ 为什么要"恒开"（用户报的"永远不会自动归档"的根因）：
  //   旧版 targetPoolDefaults() 给的是 filterEnabled:false，而决策层在固定筛选关闭时**恒为 KEEP**
  //   （只暂停后续自动发送 + 命名，绝不归档）⇒ 默认配置下脚本**永远不会归档任何会话**。
  //   本卡把默认值改为 true，并让回读归一 / 兼容路径都**恒为 true**（旧值 false 再也带不回来）。
  //
  // 名单口径（★ 7 条目录 key；内嵌表必须与 data/target-pool-presets.json 的 presets[0] 逐字相等，
  //   test/run-target-pool-tests.mjs 会断言，防手抄漂移）：
  //   · 4 个模型家族，每个家族的 agent 面 + text 面都收（沿用旧 opus 预设的做法；同一模型的另一面，
  //     不会因此保留别的模型）；
  //   · ★ 明确排除 gpt-6-astra-max-text：该行四项价全 null（无价行），内嵌表用 __unpriced__/i 占位、
  //     不留真 key ⇒ A′ 的「表外 key」校验会把**整池**判成 POOL_INVALID（H 卡 t-mv2d3a9w-23az9f 修过
  //     的真缺陷：勾 GPT 池 ⇒ PAUSE/POOL_INVALID）。GPT 6 Astra 只有 agent 一条可用。
  //     校验器 tools/validate-target-pool.mjs 对这类 key 直接报 error 并点名。
  //
  // 唯一还能改的偏好：思考流要求（不管 / 要 / 不要，默认不管），只按**可观测的标记**判断。
  //
  // ★ 控件层纪律：本段的读写只发生在这一段里，且 targetPoolApplyControls() 只改状态 + 落 localStorage，
  //   **不归档、不发消息、不取 /cost**；"切换后重判/恢复运行"由状态机（D′）在恢复运行时应用
  //   —— 本段 effects 恒为空数组，可断言。
  // ═══════════════════════════════════════════════════════════════════════════

  // ★ 预设表（**逐字由 falsify/evidence/t-mv232w13-kqdmum/repro/build-preset-file.mjs 生成**，
  //   数据源 data/target-pool-presets.json = data/arena-models-derived.json 快照现算，
  //   油猴脚本是单文件、不能读本地 JSON ⇒ 这里内嵌一份；test/run-target-pool-tests.mjs
  //   会断言内嵌表与 data/target-pool-presets.json **完全一致**，防手抄漂移。）
  const TARGET_POOL_CATALOG = {
    source: "data/arena-models-derived.json",
    sha256: "5c65b3de93e54fe63e8ec82cce600124304f4f946da696aa680988ad35b9f9ec",
    rows: 466,
    pricedRows: 366,
    unpricedRows: 100,
    completePricedRows: 76,
    singleValuedRows: 67,
    multiValuedRows: 9,
  };

  // ★ 固定名单（**唯一事实来源**，7 条目录 key）。油猴脚本是单文件、不能读本地 JSON
  //   ⇒ 这里内嵌一份；test/run-target-pool-tests.mjs 断言内嵌表与 data/target-pool-presets.json
  //   的 presets[0] **逐字相等**（含 id / title / note / default / keys）。
  const TARGET_POOL_PRESETS = [
    { id: "targets", title: "目标模型名单", note: "固定名单：只保留这 4 个贵模型（同一模型的 agent 面 + text 面都收）。", default: true, keys: [
      "claude-fable-5.1-max-text",
      "claude-opus-5.5-high-vertex",
      "contenders/claude-fable-5.1-max-agent",
      "contenders/claude-opus-5.5-high-vertex-agent",
      "contenders/gpt-6-astra-max-agent",
      "contenders/gpt-6.1-sol-max-agent",
      "gpt-6.1-sol-max",
    ] },
  ];

  // 名单的**展示分组**（4 个模型；面板据此逐条列出）。与 data/target-pool-presets.json 的
  // targetFamilies 逐条相等，且并集必须等于 TARGET_POOL_PRESETS[0].keys ——
  // 两条都由 test/run-target-pool-tests.mjs 现算比对（防"面板显示的和判定用的不是一份"）。
  const TARGET_POOL_MODELS = [
    { id: "gpt-6-astra-max", label: "GPT 6 Astra (Max)", multiBranch: false, keys: [
      "contenders/gpt-6-astra-max-agent",
    ] },
    { id: "gpt-6.1-sol-max", label: "GPT 6.1 Sol (Max)", multiBranch: true, keys: [
      "contenders/gpt-6.1-sol-max-agent",
      "gpt-6.1-sol-max",
    ] },
    { id: "claude-opus-5.5-high-vertex", label: "Claude Opus 5.5 (High)", multiBranch: false, keys: [
      "contenders/claude-opus-5.5-high-vertex-agent",
      "claude-opus-5.5-high-vertex",
    ] },
    { id: "claude-fable-5.1-max", label: "Claude Fable 5.1 (Max)", multiBranch: false, keys: [
      "contenders/claude-fable-5.1-max-agent",
      "claude-fable-5.1-max-text",
    ] },
  ];

  /**
   * 回读本地记忆时读到**旧形状**（卡 B′ 的 presetIds / rowKeys / droppedKeys / custom）⇒ 提示一次。
   * ★ 措辞**不含**「请重新选择」：用户已经不能重选名单了，那句话现在只会误导
   *   （GPT 最终裁定第 2 条：删掉「池配置已变化，请重新选择」这类提示）。
   *   只提示、不参与判定；用户下一次改思考流开关时随落盘一起清掉。
   */
  const TARGET_POOL_LEGACY_NOTICE = "旧版本的候选池选择已忽略：本版改为固定目标名单，固定筛选恒开（命中即保留；未命中自动归档；无费用证据则暂停、不归档）。";

  /**
   * 名单里"可能停在 unconstrained（不保证可识别）"的 key ⇒ 面板如实标注。
   * ★ 必须与 `tools/validate-target-pool.mjs` 对**当前固定名单**现算的 warn 集逐条相等（测试 C5 断言）：
   *   名单只剩 4 个目标模型后，只有 GPT 6.1 Sol (Max) 的 agent/text 两面因 cr∈{0.1,0.2} 打 warn；
   *   缺 cr/cw 的旧行（luna 等）已不在名单里，不再出现在这张表里。
   */
  const TARGET_POOL_RISK = {
    "contenders/gpt-6.1-sol-max-agent": "cr 是多分支价（2 个取值）",
    "gpt-6.1-sol-max": "cr 是多分支价（2 个取值）",
  };

  /** 多分支价（≥2 个不同取值）的目录 key ⇒ 名单展示区打标「多分支价」；只打 warn、不拦下（校验器口径）。 */
  const TARGET_POOL_MULTI_BRANCH = {
    "barium-bb-wlqc-text": "cr 是多分支价（2 个取值）",
    "claude-sonnet-5-5-xhigh": "cr 是多分支价（2 个取值）",
    "contenders/barium-bb-v2-4xts-agent": "cr 是多分支价（2 个取值）",
    "contenders/gpt-6-sol-max-agent": "cr 是多分支价（2 个取值）",
    "contenders/gpt-6.1-sol-max-agent": "cr 是多分支价（2 个取值）",
    "gpt-6-sol-max-text": "cr 是多分支价（2 个取值）",
    "gpt-6.1-sol-max": "cr 是多分支价（2 个取值）",
    "grok-2-2024-08-13": "cr 是多分支价（2 个取值）",
    "grok-2-mini-2024-08-13": "cr 是多分支价（2 个取值）",
  };
  const TARGET_POOL_MULTI_BRANCH_TAG = "多分支价";
  const TARGET_POOL_MULTI_BRANCH_NOTE = "能否命中，以实际费用判定为准。";

  const TARGET_POOL_STORAGE = STORAGE + ':target-pool';
  // ★ 固定名单的 id（与 TARGET_POOL_PRESETS[0].id 同源；只作"这是哪份名单"的标识，不是可选项）。
  const TARGET_POOL_TARGET_ID = 'targets';
  // ★ 固定筛选**恒开**（本卡核心不变量）：默认值、回读归一、控件层、自动化侧一律 true。
  //   —— 这是用户报的"永远不会自动归档"的根因修复：旧默认值是 false，决策层在关闭时恒为 KEEP。
  const TARGET_POOL_FIXED_FILTER = true;
  const THOUGHT_REQUIREMENTS = ['any', 'require', 'avoid'];
  const THOUGHT_REQUIREMENT_LABELS = { any: '不管', require: '要', avoid: '不要' };
  const TARGET_POOL_RISK_NOTE = '可能停在 unconstrained，不保证可识别';

  /** 目录行 key 的比较器：字典序升序（UTF-16 码元序），与内核 report 行序同一口径。 */
  function targetPoolKeyCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * 固定名单的 key 集合（去重 + 字典序升序）。**面板 / 判定 / 自动化三处共用的唯一来源**：
   * 名单恒定 ⇒ 与传入的 state 无关（保留 state 参数只为了让旧调用点签名不变）。
   */
  function targetPoolFixedKeys() {
    const seen = new Set();
    for (const p of TARGET_POOL_PRESETS) for (const k of (p.keys || [])) if (typeof k === 'string' && k) seen.add(k);
    return [...seen].sort(targetPoolKeyCompare);
  }

  /**
   * 首次默认（也是**唯一**可能的状态）：
   *   · targetId：固定名单的标识（旧值的 presetIds / rowKeys 一概不参与）；
   *   · filterEnabled：**恒 true**，旧值 false 也带不回来；
   *   · thoughtRequirement：唯一还能改的偏好（默认「不管」）；
   *   · legacy：只读提示标记 —— 回读到旧形状的本地记忆时为 true，**不参与任何判定**。
   */
  function targetPoolDefaults() {
    return {
      targetId: TARGET_POOL_TARGET_ID,
      filterEnabled: TARGET_POOL_FIXED_FILTER,
      thoughtRequirement: 'any',
      legacy: false,
    };
  }

  /** 旧形状的字段名（卡 B′ 落过盘的那些）—— 读到任一即置一次提示标记（只提示，不参与判定）。 */
  const TARGET_POOL_LEGACY_FIELDS = ['presetIds', 'rowKeys', 'droppedKeys', 'custom'];

  /**
   * 归一回读到的状态（**只读、绝不抛**）：
   *   · 名单**不在状态里**（名单恒定）⇒ 旧值里的 presetIds / rowKeys / droppedKeys / custom
   *     **一律忽略**：它们既不能改变名单、也不能关掉固定筛选（GPT 最终裁定 Q3）；
   *   · filterEnabled：**恒 true** —— 旧值 false / 缺失 / 错误类型都改不动它；
   *   · thoughtRequirement：三态之外的取值一律退回 'any'（唯一保留的旧偏好）；
   *   · legacy：读到过旧形状字段 ⇒ true（只作提示，不参与判定）。
   */
  function targetPoolNormalize(raw) {
    const d = targetPoolDefaults();
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    // ★ 旧形状判定：① 旧字段（presetIds / rowKeys / droppedKeys / custom）出现；
    //   ② filterEnabled 存在且**不是 true**（恒开之后不该再出现 false —— 用户机器上那个 false
    //      正是"永远不会自动归档"的根因，读到它就该提示一次"旧值已忽略"）。
    const legacyFields = TARGET_POOL_LEGACY_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(src, k));
    const staleFilter = Object.prototype.hasOwnProperty.call(src, 'filterEnabled') && src.filterEnabled !== true;
    const legacy = legacyFields || staleFilter || src.legacy === true;
    return {
      targetId: d.targetId,
      filterEnabled: TARGET_POOL_FIXED_FILTER,
      thoughtRequirement: THOUGHT_REQUIREMENTS.includes(src.thoughtRequirement) ? src.thoughtRequirement : d.thoughtRequirement,
      legacy,
    };
  }

  /**
   * 本地记忆：读（坏 JSON / 类型错误 / localStorage 不可用一律退回默认，**绝不抛**）。
   * ★ 旧存量值的降级口径：名单恒定 + 筛选恒开 ⇒ 旧值里任何字段都不会被带回判定路径；
   *   读到旧形状只置一次 legacy 提示（targetPoolLegacyNotice），且**不覆盖固定名单**。
   */
  function targetPoolLoad() {
    try {
      const text = localStorage.getItem(TARGET_POOL_STORAGE);
      return targetPoolNormalize(text ? JSON.parse(text) : null);
    } catch (_) {
      return targetPoolDefaults();
    }
  }

  /** 本地记忆：写（只落本地；失败静默 —— 记忆丢了不影响判定，名单本来就是固定的）。 */
  function targetPoolPersist() {
    try {
      localStorage.setItem(TARGET_POOL_STORAGE, JSON.stringify({
        targetId: targetPoolState.targetId,
        filterEnabled: TARGET_POOL_FIXED_FILTER,
        thoughtRequirement: targetPoolState.thoughtRequirement,
      }));
    } catch (_) {}
  }

  let targetPoolState = targetPoolLoad();

  function targetPoolPresetById(id) {
    return TARGET_POOL_PRESETS.find((p) => p.id === id) || null;
  }

  /**
   * 生效名单 keys（**所有判定路径的唯一来源**：首次加载 / 自动化启动 / 证据刷新 / 开关重判）。
   * 恒定 = 内嵌固定名单，与 state 无关（因此旧状态里的一切都不可能把它换掉）。
   */
  function targetPoolEffectiveKeys() {
    return targetPoolFixedKeys();
  }

  /** 固定筛选是否恒开（恒 true；给自动化侧当常量读，避免它再去读可被旧值污染的字段）。 */
  function targetPoolFixedFilterEnabled() {
    return TARGET_POOL_FIXED_FILTER;
  }

  /** 名单名称（恒定；旧值里的"自定义"分支已删除）。 */
  function targetPoolTitle() {
    const p = targetPoolPresetById(TARGET_POOL_TARGET_ID);
    return p && p.title ? p.title : TARGET_POOL_TARGET_ID;
  }

  /** 旧形状提示文案（空字符串 = 没读到旧值）——面板照原样显示，**不是**"请重新选择"。 */
  function targetPoolLegacyNotice(state) {
    const s = state || targetPoolState;
    return s && s.legacy === true ? TARGET_POOL_LEGACY_NOTICE : '';
  }

  /**
   * ★ 控件层唯一入口：应用一次控件改动。
   *   本版**只剩思考流要求**这一个偏好（名单恒定、筛选恒开）。
   *   传进来的 presetIds / rowKeys / filterEnabled / toggleKey / reset 等旧 patch 一律**忽略**
   *   （不再有对应入口，也不许它们把筛选关掉）；
   *   **只改状态 + 落本地记忆**；返回 { changed, state, effects }，effects **恒为空数组**。
   */
  function targetPoolApplyControls(patch) {
    const before = JSON.stringify(targetPoolState);
    const next = targetPoolNormalize(targetPoolState);
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    if (typeof p.thoughtRequirement === 'string' && THOUGHT_REQUIREMENTS.includes(p.thoughtRequirement)) {
      next.thoughtRequirement = p.thoughtRequirement;
    }
    if (p.reset === true) next.thoughtRequirement = targetPoolDefaults().thoughtRequirement;
    // 用户动手改过偏好 = 已经看到旧值提示 ⇒ 清掉提示标记。
    if (Object.keys(p).length) next.legacy = false;
    targetPoolState = targetPoolNormalize(next);
    const changed = JSON.stringify(targetPoolState) !== before;
    if (changed) targetPoolPersist();
    return { changed, state: targetPoolState, effects: [] };
  }

  function targetPoolSetThought(requirement) { return targetPoolApplyControls({ thoughtRequirement: requirement }); }

  /** 成员资格 = 目录 key 集合（去重排序）。价向量**不参与**成员资格，同价不会自动扩充成员。 */
  function targetPoolMembership(keys) {
    const seen = new Set();
    for (const k of Array.isArray(keys) ? keys : []) if (typeof k === 'string' && k) seen.add(k);
    return [...seen].sort(targetPoolKeyCompare);
  }

  /** 名单里"可能停在 unconstrained"的 key（缺价 / 多分支价）⇒ 面板如实标注，**不**因此踢出名单。 */
  function targetPoolRiskKeys(keys) {
    const out = [];
    for (const k of targetPoolMembership(keys)) {
      if (Object.prototype.hasOwnProperty.call(TARGET_POOL_RISK, k)) { out.push({ key: k, reason: TARGET_POOL_RISK[k] }); continue; }
      // 名单里的多分支价行（如 GPT 6.1 Sol (Max)）同样要如实标注。
      if (Object.prototype.hasOwnProperty.call(TARGET_POOL_MULTI_BRANCH, k)) {
        out.push({ key: k, reason: TARGET_POOL_MULTI_BRANCH[k] + '（' + TARGET_POOL_MULTI_BRANCH_TAG + '）' });
      }
    }
    return out;
  }

  /**
   * 该目录 key 是不是多分支价（四价齐全但 ≥2 个不同取值）⇒ 名单展示区打标「多分支价」。
   * ★ 只**打标**，不拦下、不踢出：E5 实测里这种行在 01a12408 是能进 complete 的，
   *   所以文案只说「能否命中，以实际费用判定为准。」（见 TARGET_POOL_MULTI_BRANCH_NOTE）。
   */
  function targetPoolMultiBranchReason(key) {
    return Object.prototype.hasOwnProperty.call(TARGET_POOL_MULTI_BRANCH, key) ? TARGET_POOL_MULTI_BRANCH[key] : null;
  }

  /** 预设的说明（面板上逐字展示：「全部四价单值（67）」＝「四项价格均为单一值。」）。 */
  function targetPoolPresetNote(id) {
    const p = targetPoolPresetById(id);
    return p && p.note ? p.note : '';
  }

  /** key 的展示名（内嵌目录的 disp；查不到就退回 key 本身）。 */
  function targetPoolKeyLabel(key) {
    const row = targetPoolCatalogRows().find((r) => r.key === key);
    return row && row.disp ? row.disp : key;
  }

  /**
   * 命中 key ⇒ 展示名列表。
   * identifyPolicy 的**公开返回值**里只有 matchedKeys（matchedNames 只活在它内部的消息里），
   * 所以这里用内嵌目录把 key 还原成展示名；查不到的退回 key，绝不编造名字。
   */
  function targetPoolMatchedNames(keys) {
    return (Array.isArray(keys) ? keys : []).map((k) => targetPoolKeyLabel(k));
  }

  /** 运行中的目录身份：内嵌 bundle 的 sourceSha256（= data/arena-models-derived.json 字节哈希）。 */
  function targetPoolRunningCatalogHash() {
    try {
      if (typeof __IDENTIFY_BUNDLE__ !== 'undefined' && __IDENTIFY_BUNDLE__ && __IDENTIFY_BUNDLE__.sourceSha256) {
        return String(__IDENTIFY_BUNDLE__.sourceSha256);
      }
    } catch (_) {}
    return null;
  }

  /** 内嵌目录行（名单展示 / 同价分组展示用；无 DOM、纯映射）。 */
  function targetPoolCatalogRows() {
    try {
      if (typeof __IDENTIFY_BUNDLE__ === 'undefined' || !__IDENTIFY_BUNDLE__ || !Array.isArray(__IDENTIFY_BUNDLE__.rows)) return [];
      return __IDENTIFY_BUNDLE__.rows.map((r) => ({
        key: r[1], disp: r[2], org: r[3], tier: r[4],
        prices: { input: r[5], output: r[6], cacheRead: r[7], cacheWrite: r[8] },
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * 同价分组（**只用于展示**）：按价向量把"池内 key"与"池外同价 key"分开列出。
   * 返回值里的 outOfPool **不会**被并进池 —— 池的成员资格只由 keys 决定（见 targetPoolMembership）。
   */
  function targetPoolPriceGroups(keys, rows) {
    const list = Array.isArray(rows) ? rows : targetPoolCatalogRows();
    const pool = new Set(targetPoolMembership(keys));
    const byVector = new Map();
    for (const row of list) {
      if (!row || typeof row.key !== 'string') continue;
      let vk = null;
      try { vk = typeof priceVectorKey === 'function' ? priceVectorKey(row.prices) : null; } catch (_) { vk = null; }
      if (!vk) continue;
      if (!byVector.has(vk)) byVector.set(vk, { vectorKey: vk, inPool: [], outOfPool: [] });
      const g = byVector.get(vk);
      (pool.has(row.key) ? g.inPool : g.outOfPool).push(row.key);
    }
    return [...byVector.values()]
      .filter((g) => g.inPool.length)
      .map((g) => ({
        vectorKey: g.vectorKey,
        inPool: g.inPool.slice().sort(targetPoolKeyCompare),
        outOfPool: g.outOfPool.slice().sort(targetPoolKeyCompare),
      }))
      .sort((a, b) => targetPoolKeyCompare(a.vectorKey, b.vectorKey));
  }

  /** report 是否可用于判定（与 A′ identifyPolicyEvidence 的三项形状同口径；只读、不抛）。 */
  function targetPoolReportUsable(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
    if (!Array.isArray(report.complete) || !Array.isArray(report.unconstrained)) return false;
    const reg = report.regime;
    if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return false;
    return typeof reg.longContextMessages === 'number' && Number.isFinite(reg.longContextMessages) && reg.longContextMessages >= 0;
  }

  /**
   * ★ 池切换 / 开关切换后的重判路径（两分支；**两支都不重新请求 /cost**）：
   *   · 同一目录版本 + 有效 report ⇒ REJUDGE_IN_PLACE：就地重判（用已抓到的原始响应重算）
   *   · 目录版本变了         ⇒ RERUN_KERNEL：提示用**留存的 cost JSON** 重跑内核
   *   · 还没有有效 report     ⇒ NEED_EVIDENCE：等费用结算
   * needsCostFetch 恒为 false ⇒ 测试可断言"切换池不会新增 /cost 请求"。
   */
  function targetPoolRejudgePlan(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const poolHash = typeof o.poolCatalogHash === 'string' ? o.poolCatalogHash : TARGET_POOL_CATALOG.sha256;
    const runHash = typeof o.runningCatalogHash === 'string' ? o.runningCatalogHash : targetPoolRunningCatalogHash();
    const base = { poolCatalogHash: poolHash, runningCatalogHash: runHash, needsCostFetch: false };
    if (o.hasValidReport !== true) {
      return { ...base, mode: 'NEED_EVIDENCE', message: '等待费用结算，尚未作出保留或归档决定' };
    }
    if (runHash && poolHash && runHash === poolHash) {
      return { ...base, mode: 'REJUDGE_IN_PLACE', message: '目录版本未变（sha256 一致）：就地重判，不重新请求 /cost' };
    }
    return { ...base, mode: 'RERUN_KERNEL', message: '目录版本已变化：请用留存的 cost JSON 重跑内核（不重新请求 /cost）' };
  }

  /**
   * 思考流三态判定（只看**可观测**标记，绝不推断模型内部）：
   *   any     → 'ok'（不管；标记是什么都不影响）
   *   require → 看到标记 'ok'；明确没看到 'mismatch'；从未观测 'unknown'（不拿"没观测"当证据）
   *   avoid   → 看到标记 'mismatch'；没看到 / 没观测 'ok'（排除法：看到才排除）
   */
  function targetPoolThoughtState(requirement, detected) {
    const req = THOUGHT_REQUIREMENTS.includes(requirement) ? requirement : 'any';
    if (req === 'any') return 'ok';
    if (detected === true) return req === 'avoid' ? 'mismatch' : 'ok';
    if (detected === false) return req === 'require' ? 'mismatch' : 'ok';
    return req === 'require' ? 'unknown' : 'ok';
  }

  /**
   * 最终判定 = A′ 的成员关系判定（identifyPolicy） + 思考流要求的执行口径。
   *
   * @returns {{decision,reason,action,archive,send,suspendAutomation,filterEnabled,thoughtRequirement,
   *            thoughtState,poolEmpty,poolKeys,matchedKeys,matchedNames,completeCount,unconstrainedCount,
   *            ignoredCount,longContextMessages,limitations,plan,message}}
   *   · 固定筛选**恒开**（本卡）：不再有「关闭 ⇒ 永远 KEEP」的分支 —— POOL_MISS / NO_COMPLETE /
   *     NO_EVIDENCE 一律 ARCHIVE（这就是修掉「永远不会自动归档」的地方）。
   *   · POOL_INVALID / POOL_EMPTY 仍保留为**防御分支** → PAUSE：名单恒非空且都是表内 key，
   *     正常路径走不到，但配置被外部破坏时宁可暂停也不误归档。
   *   · archive / send / suspendAutomation 是给 D′ 的执行意图；B′ 自己一个都不执行。
   */
  function targetPoolJudgement(report, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const state = o.state || targetPoolState;
    const poolKeys = Array.isArray(o.poolKeys) ? targetPoolMembership(o.poolKeys) : targetPoolEffectiveKeys(state);
    const policy = identifyPolicy(report, {
      poolKeys,
      poolCatalogHash: TARGET_POOL_CATALOG.sha256,
      runningCatalogHash: typeof o.runningCatalogHash === 'string' ? o.runningCatalogHash : targetPoolRunningCatalogHash(),
      evidenceFinal: o.evidenceFinal === true,
      // 不传 knownCatalogKeys：浏览器里只有 366 条有价行（另有 100 条只留计数），
      // 拿它当"宇宙"会把名单里缺部分价的 key 误判成未知 ⇒ POOL_INVALID。
      // key 宇宙的存在性由离线校验器 tools/validate-target-pool.mjs 负责。
    });
    const thoughtState = targetPoolThoughtState(state.thoughtRequirement, o.thoughtDetected);
    const thoughtMismatch = thoughtState === 'mismatch';
    const thoughtUnknown = thoughtState === 'unknown';
    let action;
    let reason;
    let archive = false;
    let suspendAutomation = false;
    if (thoughtMismatch) {
      action = 'ARCHIVE';
      archive = true;
      reason = 'THOUGHT_MISMATCH';
    } else if (thoughtUnknown) {
      action = 'WAIT';                        // 要 thinking 但还没观测到标记 ⇒ 等，不归档
      reason = 'THOUGHT_UNKNOWN';
    } else {
      action = policy.decision;
      archive = policy.decision === 'ARCHIVE';
      suspendAutomation = policy.decision === 'PAUSE';
      reason = policy.reason;
    }
    return {
      decision: policy.decision,
      reason,
      message: policy.message,
      action,
      archive,
      send: false,
      suspendAutomation,
      // ★ 恒 true（常量）：面板与自动化照旧读到"开"，但已经没有任何入口能把它改成 false。
      filterEnabled: TARGET_POOL_FIXED_FILTER,
      thoughtRequirement: state.thoughtRequirement,
      thoughtState,
      poolEmpty: policy.reason === 'POOL_EMPTY',
      poolKeys,
      matchedKeys: policy.matchedKeys,
      matchedNames: targetPoolMatchedNames(policy.matchedKeys),
      completeCount: policy.completeCount,
      unconstrainedCount: policy.unconstrainedCount,
      ignoredCount: policy.ignoredCount,
      longContextMessages: Number((report && report.regime && report.regime.longContextMessages) || 0),
      limitations: policy.limitations,
      plan: targetPoolRejudgePlan({
        hasValidReport: targetPoolReportUsable(report),
        poolCatalogHash: TARGET_POOL_CATALOG.sha256,
        runningCatalogHash: typeof o.runningCatalogHash === 'string' ? o.runningCatalogHash : targetPoolRunningCatalogHash(),
      }),
    };
  }

  /** 汇总给面板的只读视图（纯函数：只读状态与 report，不碰 DOM）。 */
  function targetPoolView(report, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const state = o.state || targetPoolState;
    const keys = targetPoolEffectiveKeys(state);
    const legacyNotice = targetPoolLegacyNotice(state);
    return {
      // ★ 名单展示分组（4 个模型，含 agent + text 两面）——面板只读展示，没有勾选入口。
      models: TARGET_POOL_MODELS.map((m) => ({
        id: m.id, label: m.label, multiBranch: m.multiBranch === true, keys: m.keys.slice(),
      })),
      presets: TARGET_POOL_PRESETS.map((p) => ({
        id: p.id, title: p.title, note: p.note || '', strictSingle: p.strictSingle === true,
        default: p.default === true, count: p.keys.length,
      })),
      targetId: state.targetId,
      // 旧值只提示一次；**不是**"请重新选择"（用户已经不能重选名单了）。
      legacyNotice,
      poolTitle: targetPoolTitle(),
      poolKeys: keys,
      poolCount: keys.length,
      risks: targetPoolRiskKeys(keys),
      riskNote: TARGET_POOL_RISK_NOTE,
      catalog: TARGET_POOL_CATALOG,
      runningCatalogHash: typeof o.runningCatalogHash === 'string' ? o.runningCatalogHash : targetPoolRunningCatalogHash(),
      // 恒 true（常量）：面板照旧显示"固定筛选=开"，但已无处可关。
      filterEnabled: TARGET_POOL_FIXED_FILTER,
      thoughtRequirement: state.thoughtRequirement,
      thoughtLabel: THOUGHT_REQUIREMENT_LABELS[state.thoughtRequirement] || '不管',
      judgement: o.judgement || (report === undefined ? null : targetPoolJudgement(report, o)),
      rename: o.rename || null,
      archive: o.archive || null,
    };
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({
        config,
        run: {
          phase: run.phase,
          sessionId: run.sessionId,
          owned: run.owned,
          completedRounds: run.completedRounds,
          pendingRound: run.pendingRound,
          verdict: run.verdict,
          lastCost: run.lastCost,
          reason: run.reason,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          attempt: run.attempt,
          probeIndex: run.probeIndex,
        },
      }));
    } catch (_) {}
    renderStatus();
  }

  function encodeCookieValue(value) {
    return encodeURIComponent(JSON.stringify(value));
  }

  // 只设置页面声明的 override，不删除 localStorage，也不清理用户其它状态。
  function enableBillingFlag() {
    let overrides = {};
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + FLAG_COOKIE + '=([^;]*)'));
    if (m) {
      try { overrides = JSON.parse(decodeURIComponent(m[1])); } catch (_) { overrides = {}; }
    }
    overrides['credit-system-m1'] = 'cost-shown';
    document.cookie = FLAG_COOKIE + '=' + encodeCookieValue(overrides) + '; path=/; max-age=604800; SameSite=Lax';
    window.__ARENA_BILLING_FLAG_OVERRIDE__ = 'credit-system-m1=cost-shown';
  }

  function currentSessionId() {
    const m = location.pathname.match(/^\/agent\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function probeList() {
    const rows = String(config.probeText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return [...new Set(rows)].length ? [...new Set(rows)] : DEFAULT_PROBES;
  }

  function probeForAttempt(attempt) {
    const prompts = probeList();
    const index = ((Math.max(0, Number(attempt) || 0)) % prompts.length + prompts.length) % prompts.length;
    return { prompt: prompts[index], index, total: prompts.length };
  }

  function humanVerificationVisible() {
    // 不扫描整个 body.innerText：Arena 的隐藏预加载/无障碍文案可能含有
    // “verify you are human”，会把正常页面误判成验证页并立即 STOPPED。
    const challengeNodes = [...document.querySelectorAll(
      'iframe, [data-sitekey], [id*="captcha" i], [class*="captcha" i], [id*="turnstile" i], [class*="turnstile" i]'
    )];
    if (challengeNodes.some((el) => isVisible(el))) return true;

    const textNodes = [...document.querySelectorAll(
      'button, [role="alert"], [role="dialog"], label, h1, h2, h3, p, span, div'
    )];
    return textNodes.some((el) => {
      if (!isVisible(el) || el.children.length > 0) return false;
      return HUMAN_VERIFICATION.test(String(el.textContent || ''));
    });
  }

  function activeAutomation(token) {
    return token === automationToken && run.phase !== 'STOPPED' && run.phase !== 'DONE';
  }

  function sessionIdFromUrl(url) {
    const m = String(url || '').match(COST_ROUTE);
    return m ? m[1] : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    const s = getComputedStyle(el);
    return !!r && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function textOf(el) {
    return [el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.textContent]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function dispatchInput(el, value) {
    if (!el) return false;
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return true;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function composer() {
    const selectors = [
      '[contenteditable="true"]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="消息"]',
      'textarea',
    ];
    for (const selector of selectors) {
      const el = [...document.querySelectorAll(selector)].find(isVisible);
      if (el) return el;
    }
    return null;
  }

  function sendButton() {
    const els = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    return els.find((el) => {
      const t = textOf(el);
      return /^(send|发送|提交)$/i.test(t) || /send message|发送消息|submit/i.test(t);
    }) || els.find((el) => /send|发送/.test(textOf(el)) && !/stop|停止/.test(textOf(el)));
  }

  async function sendText(text) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const input = composer();
      if (input) {
        dispatchInput(input, text);
        await wait(80);
        const button = sendButton();
        if (button) { button.click(); return true; }
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      }
      await wait(300);
    }
    return false;
  }

  function stopGeneration() {
    const button = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .find((el) => /stop|停止|cancel generation|中止/i.test(textOf(el)));
    if (button) { button.click(); return true; }
    return false;
  }

  function rowForSession(sid) {
    const link = [...document.querySelectorAll('a[href]')].find((a) => {
      try { return new URL(a.href, location.href).pathname === '/agent/' + sid; } catch (_) { return false; }
    });
    if (!link) return null;
    let node = link;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if ([...node.querySelectorAll('button,[role="button"]')].some((b) => /more|option|更多|选项/.test(textOf(b)))) return node;
    }
    return link.parentElement;
  }

  async function openSessionMenu(sid) {
    const row = rowForSession(sid);
    const candidates = row ? [...row.querySelectorAll('button,[role="button"]')] : [];
    const button = candidates.find((el) => /more|option|更多|选项/.test(textOf(el)))
      || [...document.querySelectorAll('button,[role="button"]')].find((el) => isVisible(el) && /more|option|更多|选项/.test(textOf(el)));
    if (!button) return false;
    button.click();
    await wait(120);
    return true;
  }

  function menuItem(re) {
    return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], button')]
      .filter(isVisible).find((el) => re.test(textOf(el)));
  }

  async function renameOwnedSession(name) {
    if (!run.owned || !run.sessionId) return false;
    const sid = run.sessionId;
    try {
      const response = await fetch(`/api/history/agentic/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: String(name).slice(0, 100) }),
      });
      if (response.ok) return true;
    } catch (_) {}
    if (!await openSessionMenu(run.sessionId)) return false;
    const item = menuItem(/^(rename|重命名|改名)$/i);
    if (!item) return false;
    item.click();
    await wait(120);
    const input = [...document.querySelectorAll('input')].find(isVisible);
    if (!input) return false;
    dispatchInput(input, name);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await wait(120);
    return true;
  }

  async function archiveOwnedSession() {
    if (!run.owned || !run.sessionId) return false;
    const sid = run.sessionId;
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(sid)}/archive`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) return true;
    } catch (_) {}
    if (!await openSessionMenu(run.sessionId)) return false;
    const item = menuItem(/^(archive|归档)$/i);
    if (!item) return false;
    item.click();
    return true;
  }

  // ─── 归档闭环（卡片 E）：archiveAndVerify(sid, { name }) ─────────────────────
  // 目的：把“归档”做成**可核验的闭环**——只有确认归档成功，上层才允许开下一个会话。
  // 判据（与卡片验收清单一一对应）：
  //   · 只动本轮脚本创建的会话：run.owned === true 且 sid ∈ run.currentRunOwned；
  //     非 owned 一律零操作（不发任何请求、不碰 DOM）——不碰用户已有会话。
  //   · 成功只认服务端**可核验状态**，“请求已发出”不算成功（★ 判据在卡 E-FIX 收紧过）：
  //       P1 显式字段：响应体里**属于本 sid**（scope==='sid'）的对象上 archivedAt 非空，或
  //          archived/isArchived === true、status/state ∈ {archived, archive}；
  //          幂等复核同样只认 /api/history/unified?includeArchived=true 里该 sid 的 archivedAt 非空。
  //       P2（★ 卡 E-FIX 起降级为「仅辅助、单独**绝不**判成功」）：基线活动列表里有该 sid 且
  //          archivedAt 为空，归档后同一完整列表（hasMore === false）里查不到 ⇒ 只记
  //          signal='ABSENT_ONLY(...)'。「列表里查不到」是**缺失证据**（删除 / 过滤 / 分页口径
  //          变化都会让条目消失），不能当归档证据；T18 那条实测里连 includeArchived=true 也查不到它。
  //       P1 强于 P2；只有“请求发出但状态没变”时一律判失败；
  //       ★ 两条路径都没有确证 ⇒ 最终 `{ ok:false, via:'none' }`，调用方必须暂停（不得重试、不得新建会话）。
  //   · 【UNKNOWN，待 F 冒烟】P1 的复核读用 /api/history/unified?includeArchived=true：
  //     页面自己用的是 ?limit=20&includeArchived=false（recon 抓包），true 分支我无法
  //     在零副作用前提下验证，F 阶段用真实归档会话确认（见 falsify/evidence/<卡id>/）。
  //   · API 不成功才退回 UI：沿用既有 openSessionMenu + menuItem(/^(archive|归档)$/i)。
  //   · 幂等：基线已显示该会话已归档 ⇒ 直接返回 ok:false + ALREADY_ARCHIVED，
  //     不再发归档请求、不再碰 UI 菜单。
  //   · 两条路径都没确认 ⇒ { ok:false, via:'none' }，调用方必须暂停（不得重试、不得新建会话）。
  //   · 本函数不抛错：任何异常都收敛成 { ok:false, via:'none' }。
  const ARCHIVE_TUNING = {
    renameTimeoutMs: 8000,   // 改名最长等待；超时/抛错都不阻塞归档
    requestTimeoutMs: 10000, // 单次归档/复核请求超时（AbortController）
    verifyAttempts: 2,       // 复核轮数（服务端最终一致时再读一次）
    verifyDelayMs: 500,      // 复核轮间隔
    uiSettleMs: 600,         // UI 菜单点击后等待状态落定
    historyLimit: 50,        // 与页面一致：/api/history/unified?limit=50
  };

  function timeoutPromise(ms) {
    return new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, Number(ms) || 0)));
  }

  /** 带超时的 fetch：从不抛错，返回 { response, text, error }。 */
  async function archiveFetch(url, options = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      if (controller) timer = setTimeout(() => controller.abort(), Math.max(1, Number(ARCHIVE_TUNING.requestTimeoutMs) || 10000));
      const response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        ...(controller ? { signal: controller.signal } : {}),
      });
      let text = '';
      try { text = await response.text(); } catch (_) { text = ''; }
      return { response, text, error: null };
    } catch (error) {
      return { response: null, text: '', error: String((error && error.message) || error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  const ARCHIVE_STATE_WORDS = ['archived', 'archive', 'archived_only', 'archivedonly'];
  const ARCHIVE_SCOPE_KEYS = ['id', 'sessionId', 'chatId', 'agentId', 'conversationId'];

  function archiveStateWord(value) {
    return typeof value === 'string' && ARCHIVE_STATE_WORDS.includes(value.trim().toLowerCase());
  }

  /** 单个对象上的“已归档”显式字段；没有就返回 null。 */
  function archivedFlagField(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.archivedAt) return { field: 'archivedAt', value: String(node.archivedAt) };
    for (const key of ['archived', 'isArchived']) {
      const value = node[key];
      if (value === true || archiveStateWord(value)) return { field: key, value: String(value) };
    }
    for (const key of ['status', 'state']) {
      if (archiveStateWord(node[key])) return { field: key, value: String(node[key]) };
    }
    return null;
  }

  /**
   * 在响应体里找“这个会话已归档”的显式字段，返回 { field, value, scope } 或 null。
   * scope='sid'：字段所在对象明确是本 sid；scope='anonymous'：该对象没有会话 id。
   * 带**其它**会话 id 的对象一律忽略（不把别人的状态当成自己的）。
   */
  function archivedFlagInJson(root, sid) {
    let hit = null;
    const visit = (node, path, depth) => {
      if (hit || !node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
        return;
      }
      const ids = ARCHIVE_SCOPE_KEYS.map((key) => node[key]).filter((value) => typeof value === 'string');
      const sameSession = ids.includes(sid);
      if (sameSession || ids.length === 0) {
        const flag = archivedFlagField(node);
        if (flag) hit = { field: `${path}.${flag.field}`, value: flag.value, scope: sameSession ? 'sid' : 'anonymous' };
      }
      for (const [key, value] of Object.entries(node)) visit(value, `${path}.${key}`, depth + 1);
    };
    visit(root, '$', 0);
    return hit;
  }

  /** 只读复核：GET /api/history/unified（页面自己的端点）读该 sid 的归档状态。 */
  async function readHistoryListing(sid, includeArchived) {
    const url = `/api/history/unified?limit=${Number(ARCHIVE_TUNING.historyLimit) || 50}&includeArchived=${includeArchived ? 'true' : 'false'}`;
    const got = await archiveFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const out = {
      url, includeArchived: !!includeArchived, status: got.response ? got.response.status : 0,
      ok: false, error: got.error, count: 0, hasMore: null, entry: null, archivedAt: null,
    };
    if (!got.response) { out.error = got.error || 'NETWORK_ERROR'; return out; }
    if (!got.response.ok) { out.error = 'HTTP ' + out.status; return out; }
    const json = parseJsonLoose(got.text);
    const entries = Array.isArray(json) ? json : (json && Array.isArray(json.entries) ? json.entries : null);
    if (!entries) { out.error = 'UNRECOGNIZED_BODY'; return out; }
    out.ok = true;
    out.count = entries.length;
    out.hasMore = json && json.pagination && typeof json.pagination.hasMore === 'boolean' ? json.pagination.hasMore : null;
    const entry = entries.find((item) => item && (item.id === sid || item.sessionId === sid));
    out.entry = entry || null;
    out.archivedAt = entry && entry.archivedAt ? String(entry.archivedAt) : null;
    return out;
  }

  function describeListing(tag, listing) {
    if (!listing) return `${tag}=none`;
    if (!listing.ok) {
      const status = listing.status ? `HTTP ${listing.status}` : '';
      const detail = listing.error && listing.error !== status ? ` ${listing.error}` : '';
      return `${tag}=${(status + detail).trim() || 'ERROR'}`;
    }
    return `${tag}=HTTP ${listing.status} entries=${listing.count} hasMore=${listing.hasMore} sid=${listing.entry ? (listing.archivedAt ? `archivedAt=${listing.archivedAt}` : 'archivedAt=null') : 'absent'}`;
  }

  /**
   * 复核归档是否真的生效：读 /api/history/unified 两次（含归档 / 仅活动）。
   * verified=false 时 signal 说明“为什么不算成功”（绝不把请求已发出当成功）。
   */
  async function verifyArchiveState(sid, baseline) {
    const attempts = Math.max(1, Number(ARCHIVE_TUNING.verifyAttempts) || 1);
    const delayMs = Math.max(0, Number(ARCHIVE_TUNING.verifyDelayMs) || 0);
    const reads = [];
    let why = 'NO_STATE_READ';
    let absentOnly = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0 && delayMs > 0) await wait(delayMs);
      const archivedList = await readHistoryListing(sid, true);
      const activeList = await readHistoryListing(sid, false);
      reads.push(archivedList, activeList);
      // P1 显式字段：归档列表里该会话 archivedAt 非空（官方流程「归档记录仍可检索」）
      if (archivedList.ok && archivedList.archivedAt) {
        return { verified: true, signal: `listing-archivedAt-set(includeArchived=true archivedAt=${archivedList.archivedAt})`, reads };
      }
      // P2 状态变化：基线在活动列表（未归档），现在完整活动列表里查不到。
      // ★★ 卡 E-FIX（2026-10-11）：**「活动列表里查不到本 sid」是缺失证据，不是归档证据** ——
      //    删除 / 过滤 / 分页口径变化都会让条目消失；它单独**绝不能**判成功。
      //    这里只记录 signal='ABSENT_ONLY(...)' 并继续下一轮复核（把成功机会留给 P1），
      //    循环结束仍未确证 ⇒ 由下方返回 verified:false（调用方据此判定失败并暂停）。
      const baselineActive = !!(baseline && baseline.active && baseline.active.ok && baseline.active.entry && !baseline.active.archivedAt);
      if (baselineActive && activeList.ok && !activeList.entry && activeList.hasMore === false) {
        absentOnly = `ABSENT_ONLY(includeArchived=false entries=${activeList.count} hasMore=false sid=absent; baselineActive=true)`;
        continue;
      }
      why = `${describeListing('includeArchived=true', archivedList)}; ${describeListing('includeArchived=false', activeList)}; baselineActive=${baselineActive}`;
    }
    if (absentOnly) return { verified: false, signal: absentOnly, reads };
    return { verified: false, signal: `NOT_VERIFIED(${why})`, reads };
  }

  /** 步骤②：API 归档 POST /api/chat/<sid>/archive；成功与否还要看响应体显式状态。 */
  async function archiveViaApi(sid) {
    const url = `/api/chat/${encodeURIComponent(sid)}/archive`;
    const got = await archiveFetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    const out = {
      url, status: got.response ? got.response.status : 0,
      ok: !!(got.response && got.response.ok), error: got.error, bodyFlag: null,
    };
    if (!got.response) { out.error = got.error || 'NETWORK_ERROR'; return out; }
    if (!out.ok) out.error = 'HTTP ' + out.status;
    const json = parseJsonLoose(got.text);
    if (json) out.bodyFlag = archivedFlagInJson(json, sid);
    return out;
  }

  /** 当前可见菜单项快照：用来判断“这一项是不是我们刚点开的那个菜单里的”。 */
  function visibleArchiveMenus() {
    return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], button')]
      .filter(isVisible);
  }

  /**
   * 步骤④：UI 回退。沿用既有 menuItem(/^(archive|归档)$/i)，另加两道保险：
   *   · 会话行必须还在（rowForSession(sid) 非空）——否则 openSessionMenu 会退化成
   *     点“页面上第一个更多按钮”，可能开成别的会话的菜单；
   *   · 菜单项要能归因到本次点击（在本行内，或点开前不可见的“新出现”项）。
   * 归因不了就不点：宁可返回失败让上层暂停，也绝不碰别的会话。
   */
  async function archiveViaUi(sid) {
    try {
      const row = rowForSession(sid);
      if (!row) return { clicked: false, reason: 'ROW_NOT_FOUND', scope: null };
      const before = visibleArchiveMenus();
      if (!await openSessionMenu(sid)) return { clicked: false, reason: 'MENU_BUTTON_NOT_FOUND', scope: null };
      const item = menuItem(/^(archive|归档)$/i);
      if (!item) return { clicked: false, reason: 'MENU_ITEM_NOT_FOUND', scope: null };
      const inRow = !!(row.contains && row.contains(item));
      if (!inRow && before.includes(item)) return { clicked: false, reason: 'ITEM_UNATTRIBUTED', scope: null };
      item.click();
      if (Number(ARCHIVE_TUNING.uiSettleMs) > 0) await wait(Number(ARCHIVE_TUNING.uiSettleMs));
      return { clicked: true, reason: null, scope: inRow ? 'row' : 'opened-menu' };
    } catch (error) {
      return { clicked: false, reason: `UI_ERROR(${String((error && error.message) || error)})`, scope: null };
    }
  }

  /** 步骤①：改名。失败、抛错、超时都不阻塞归档（名字只是给人看的）。 */
  async function renameForArchive(sid, name, steps) {
    if (!name) { steps.push('rename=skipped(no-name)'); return; }
    if (sid !== run.sessionId) { steps.push('rename=skipped(not-current-session)'); return; }
    const timeoutMs = Math.max(1, Number(ARCHIVE_TUNING.renameTimeoutMs) || 8000);
    const pending = Promise.resolve().then(() => renameOwnedSession(name));
    pending.catch(() => {});
    const outcome = await Promise.race([
      pending.then((value) => ({ value })).catch((error) => ({ error: String((error && error.message) || error) })),
      timeoutPromise(timeoutMs).then(() => ({ timeout: true })),
    ]);
    if (outcome && outcome.timeout) steps.push(`rename=timeout(${timeoutMs}ms,不阻塞归档)`);
    else if (outcome && outcome.error) steps.push(`rename=error(${outcome.error},不阻塞归档)`);
    else steps.push(`rename=${outcome && outcome.value ? 'ok' : 'false'}`);
  }

  /**
   * 归档闭环：改名 → API 归档 → 复核 → UI 回退 → 复核。
   * 返回 { ok, via:'api'|'ui'|'none', evidence }；ok=false 时调用方必须暂停。
   */
  async function archiveAndVerify(sid, options = {}) {
    const steps = [];
    const id = typeof sid === 'string' ? sid.trim() : '';
    try {
      if (!id) return { ok: false, via: 'none', evidence: 'INVALID_SID：sid 为空，零操作' };

      // 门禁：只动 run.owned === true 且属于本轮 run.currentRunOwned 的会话。
      const inRun = Array.isArray(run.currentRunOwned) && run.currentRunOwned.includes(id);
      if (run.owned !== true || !inRun) {
        return {
          ok: false, via: 'none',
          evidence: `NOT_OWNED：run.owned=${run.owned === true} inCurrentRunOwned=${inRun} sid=${id}；零请求、零 DOM`,
        };
      }

      // 人机验证可见时暂停所有自动操作（不归档、不新建、不重试）；判定不了就当作可见（失败即暂停）。
      let challenge = true;
      try { challenge = humanVerificationVisible(); } catch (_) { challenge = true; }
      if (challenge) {
        return { ok: false, via: 'none', evidence: `HUMAN_VERIFICATION：页面出现人机验证，暂停归档 sid=${id}；零请求` };
      }

      steps.push(`sid=${id}`, 'gate=owned');
      // 基线读（只读）：先读“含归档”列表做幂等短路，再读活动列表给 P2「状态变化」判据留基线。
      const baseline = { archived: await readHistoryListing(id, true), active: null };
      steps.push(describeListing('baseline+archived', baseline.archived));
      if (baseline.archived.ok && baseline.archived.archivedAt) {
        return { ok: false, via: 'none', evidence: `ALREADY_ARCHIVED：${steps.join('；')}；未发归档请求、未碰 UI 菜单（幂等）` };
      }
      baseline.active = await readHistoryListing(id, false);
      steps.push(describeListing('baseline-active', baseline.active));

      await renameForArchive(id, options.name, steps);

      const api = await archiveViaApi(id);
      steps.push(api.bodyFlag
        ? `api=HTTP ${api.status} bodyFlag=${api.bodyFlag.field}=${api.bodyFlag.value}(scope=${api.bodyFlag.scope})`
        : `api=${api.ok ? `HTTP ${api.status} bodyFlag=none` : `FAILED(${api.error})`}`);

      // P1：响应体自带显式归档字段 **且该字段明确属于本 sid** ⇒ API 成功且复核通过。
      // ★★ 卡 E-FIX：`scope === 'anonymous'`（如根级 `$.archived=true`，没有 sid 锚点）**不得**
      //    单独触发 ok:true —— 它可能是别的对象或全局状态；此种情况降级到下面的状态复核（P1）。
      if (api.ok && api.bodyFlag && api.bodyFlag.scope === 'sid') {
        return { ok: true, via: 'api', evidence: `VERIFIED_API_BODY：${steps.join('；')}；判据=响应体显式归档字段(scope=sid)` };
      }
      // 硬失败的 API 调用不可能算我们的成功；只有它带回了显式字段时再复核一次。
      if (api.ok || api.bodyFlag) {
        const apiVerify = await verifyArchiveState(id, baseline);
        apiVerify.reads.forEach((listing) => steps.push(describeListing('verify-api', listing)));
        if (apiVerify.verified) {
          return { ok: true, via: 'api', evidence: `VERIFIED_API_STATE：${steps.join('；')}；判据=${apiVerify.signal}` };
        }
        steps.push(`api-verify=NEGATIVE(${apiVerify.signal})`);
      }

      const ui = await archiveViaUi(id);
      steps.push(ui.clicked ? `ui=clicked(scope=${ui.scope})` : `ui=not-clicked(${ui.reason})`);
      if (ui.clicked) {
        const uiVerify = await verifyArchiveState(id, baseline);
        uiVerify.reads.forEach((listing) => steps.push(describeListing('verify-ui', listing)));
        if (uiVerify.verified) {
          return { ok: true, via: 'ui', evidence: `VERIFIED_UI_STATE：${steps.join('；')}；判据=${uiVerify.signal}` };
        }
        steps.push(`ui-verify=NEGATIVE(${uiVerify.signal})`);
      }

      return { ok: false, via: 'none', evidence: `UNVERIFIED_BOTH_PATHS：${steps.join('；')}；调用方应暂停（不重试、不新建会话）` };
    } catch (error) {
      return {
        ok: false, via: 'none',
        evidence: `UNEXPECTED_ERROR：${String((error && error.message) || error)}；${steps.join('；')}`,
      };
    }
  }

  function sessionName(prefix) {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-');
    return `${prefix} · ${stamp}`;
  }

  function scanThoughtSignals(text) {
    const source = String(text || '');
    const markers = [];
    const patterns = [
      /["']type["']\s*:\s*["']([^"']+)["']/gi,
      /(?:^|\n)event:\s*([^\s\n]+)/gi,
    ];
    for (const re of patterns) {
      for (const match of source.matchAll(re)) {
        const type = match[1];
        if (THOUGHT_TYPE.test(type) && !markers.includes(type)) markers.push(type);
      }
    }
    return { detected: markers.length > 0, markers };
  }

  function numberOf(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function costDetailFromJson(root) {
    const out = [];
    const visit = (node, path, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (node.actual && typeof node.actual === 'object') {
        const a = node.actual;
        if (node.basePriceUsd != null || a.inputTokensCostUsd != null || a.outputTokensCostUsd != null) {
          out.push({
            base: node.basePriceUsd ?? null,
            in: a.inputTokensCostUsd ?? null,
            cw: a.cacheWriteTokensCostUsd ?? null,
            cr: a.cacheReadTokensCostUsd ?? null,
            out: a.outputTokensCostUsd ?? null,
            total: node.totalChargedUsd ?? a.totalCostUsd ?? null,
            costMultiplier: node.costMultiplier ?? null,
            marginMultiplier: node.marginMultiplier ?? null,
            chargedCredits: node.totalChargedCredits ?? null,
            path,
          });
        }
      }
      if (Array.isArray(node)) node.forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
      else for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`, depth + 1);
    };
    visit(root, '$', 0);
    return out.find((x) => x.base != null && x.in != null && x.out != null) || out[0] || null;
  }

  function closeEnough(a, b) {
    return Math.abs(a - b) <= Math.max(2e-8, Math.abs(b) * 2e-6);
  }

  function fitCandidate(observation, candidate) {
    const p = candidate.prices;
    const token = {};
    for (const field of ['in', 'cw', 'out']) {
      const cost = numberOf(observation[field]);
      if (cost == null || p[field] == null) return null;
      token[field] = Math.round(cost * 1e6 / p[field]);
      if (!closeEnough(cost, token[field] * p[field] / 1e6)) return null;
    }
    const crCost = numberOf(observation.cr);
    if (crCost != null && crCost !== 0 && p.cr != null) {
      token.cr = Math.round(crCost * 1e6 / p.cr);
      if (!closeEnough(crCost, token.cr * p.cr / 1e6)) return null;
    }
    const base = numberOf(observation.base);
    if (base == null) return null;
    // Agent 的参考方程对应实际计费基数；有 margin 时 totalChargedUsd 才是方程右侧。
    // 真实样本中 base=0.0032061337、margin=2，而费用方程右侧为 0.0064122674。
    const multiplier = numberOf(observation.costMultiplier) ?? 1;
    const margin = numberOf(observation.marginMultiplier) ?? 1;
    const charged = numberOf(observation.total);
    const equationAmount = charged != null ? charged : base * multiplier * margin;
    const b10 = Math.round(equationAmount * 1e10);
    const versions = BILLING_VERSIONS.filter((v) => {
      const residual = b10 - v.i * token.in - v.w * token.cw - v.o * token.out;
      if (residual < 0 || residual % v.r !== 0) return false;
      if (token.cr != null && token.cr !== residual / v.r) return false;
      return true;
    });
    if (!versions.length) return null;
    return { candidate, tokens: { ...token, cr: token.cr ?? null }, versions: versions.map((v) => v.id) };
  }

  function classify(observation) {
    const matches = CANDIDATES.map((candidate) => fitCandidate(observation, candidate)).filter(Boolean);
    const targetRe = config.target === 'opus5.5'
      ? /claude-opus-5\.5/i
      : config.target === 'opus5'
        ? /claude-opus-5(?:-|\s|\()/i
        : /claude-opus-5(?:\.|-|\s|\()/i;
    const target = matches.filter((m) => targetRe.test(m.candidate.model + ' ' + m.candidate.label));
    const competitors = matches.filter((m) => !targetRe.test(m.candidate.model + ' ' + m.candidate.label));
    return {
      accepted: target.length > 0,
      label: target.length ? 'Opus 5.5 价格候选' : (matches[0]?.candidate.label || '未匹配'),
      matches: matches.map((m) => ({ model: m.candidate.model, label: m.candidate.label, versions: m.versions, tokens: m.tokens })),
      competitors: competitors.map((m) => m.candidate.label),
      reason: target.length ? 'PRICE_VECTOR_MATCH' : matches.length ? 'NON_TARGET_PRICE_VECTOR' : 'INSUFFICIENT_OR_CONTRADICTORY_COST',
    };
  }

  function extractCost(text) {
    try {
      const root = typeof text === 'string' ? JSON.parse(text) : text;
      return costDetailFromJson(root);
    } catch (_) {
      return null;
    }
  }

  function streamPackets(frame) {
    const data = String(frame || '').split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    let root;
    try { root = JSON.parse(data); } catch (_) { return []; }
    const packets = [];
    const visit = (node, record, depth) => {
      if (!node || typeof node !== 'object' || depth > 5) return;
      if (Array.isArray(node.records)) {
        for (const row of node.records) {
          if (Array.isArray(row.headers) && row.headers.some((pair) => pair[0] === 'trigger-control' && pair[1] === 'turn-complete'))
            packets.push({ type: 'turn-complete', seq: row.seq_num });
          if (typeof row.body === 'string') {
            try { visit(JSON.parse(row.body), row, depth + 1); } catch (_) {}
          }
        }
        return;
      }
      if (typeof node.type === 'string') {
        packets.push(Object.assign({}, node, { seq: record && record.seq_num,
          startedAt: node.messageMetadata && node.messageMetadata.timing && node.messageMetadata.timing.startedAt }));
        return;
      }
      if (node.data && typeof node.data === 'object') visit(node.data, record, depth + 1);
    };
    visit(root, null, 0);
    return packets;
  }

  async function inspectStream(response, sid, options) {
    let reader;
    let turn = null;
    const realtime = !options || options.realtime !== false;
    try {
      const clone = response.clone();
      reader = clone.body?.getReader();
      if (!reader || !sid) return;
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = (frame) => {
        for (const packet of streamPackets(frame)) {
          automationStreamRecord(sid, packet.seq);
          if (packet.type === 'start') {
            const binding = automationStreamStart(sid, packet);
            if (binding) turn = { binding, outputSeen: !!(turn && turn.binding.roundToken === binding.roundToken
              && turn.binding.automationToken === binding.automationToken && turn.outputSeen), finishSeen: false, complete: false };
            else turn = null;
            continue;
          }
          if (!turn) continue;
          // ★ 2026-10-11（用户权威口径）：**流量不再作为思考判据**，判据改为页面上真正渲染出来的
          //   thinking 标签（见 30-automation.js 的 automationDomThinkingLabel）。
          //   真机反例：同一条 assistant 消息里 7 个 reasoning 部件 text 全为空、页面不显示任何思考，
          //   这里却会命中 reasoning-start ⇒ 误判「有思考」。而且当时会 return true 掐断流读取，
          //   导致永远等不到 turn-complete（会话卡在「等待输出完成」、也拿不到计价与模型名）。
          if (packet.type === 'text-delta' && typeof packet.delta === 'string' && packet.delta.length) turn.outputSeen = true;
          if (packet.type === 'error' || packet.type === 'abort') {
            automationStreamEvent(Object.assign({}, turn.binding, { kind: 'STREAM_END', normalEnd: false }));
            turn = null;
            continue;
          }
          if (packet.type === 'finish') {
            const metadata = packet.messageMetadata || {};
            const nodeId = metadata.nodeId || packet.messageId;
            if (nodeId && !turn.binding.messageIds.includes(String(nodeId))) continue;
            if (metadata.pending === true || /error|abort|cancel/i.test(String(packet.finishReason || ''))) continue;
            turn.finishSeen = true;
          }
          // A realtime connection is not a turn: finish/text-end/EOF are insufficient.
          // Arena's turn-complete control record must follow this round's own start and finish.
          if ((packet.type === 'turn-complete' && turn.finishSeen) || (!realtime && packet.type === 'finish')) {
            automationStreamEvent(Object.assign({}, turn.binding, { kind: 'STREAM_END', normalEnd: true,
              outputSeen: turn.outputSeen, messageIds: turn.binding.messageIds }));
            turn.complete = true;
          }
        }
        return false;
      };
      while (true) {
        const part = await reader.read();
        buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          if (consume(frame)) { void reader.cancel().catch(() => {}); return; }
        }
        if (part.done) {
          if (buffer && consume(buffer)) return;
          if (turn && !turn.complete) automationStreamEvent(Object.assign({}, turn.binding, { kind: 'STREAM_END', normalEnd: false }));
          break;
        }
        if (buffer.length > 1000000) {
          if (turn) automationStreamEvent(Object.assign({}, turn.binding, { kind: 'STREAM_END', normalEnd: false }));
          void reader.cancel().catch(() => {});
          return;
        }
      }
    } catch (_) {
      if (turn) automationStreamEvent(Object.assign({}, turn.binding, { kind: 'STREAM_END', normalEnd: false }));
    }
  }

  function observeResponse(url, response, request) {
    const streamMatch = String(url || '').match(/\/realtime\/v1\/sessions\/([^/?#]+)\/out(?:[?#]|$)/);
    const sid = streamMatch ? streamMatch[1] : sessionIdFromUrl(url) || currentSessionId();
    let mime = '';
    try { mime = response.headers.get('content-type') || ''; } catch (_) {}
    if (/event-stream/i.test(mime)) {
      if (streamMatch) void inspectStream(response, sid, { realtime: true });
      return;
    }
    if (!COST_ROUTE.test(String(url))) return;
    let clone;
    try { clone = response.clone(); } catch (_) { return; }
    clone.text().then((text) => {
      // 页面自己发的 /cost 响应也留一份原文给识别面板/导出（只认当前会话，见 setIdentifySource）。
      setIdentifySource(sid, text);
      const evidence = extractCost(text);
      if (evidence) onCost(sid, evidence, Object.assign({ url: String(url), status: response.status }, request || {}));
    }).catch(() => {});
  }

  function installNetworkHooks() {
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : input?.url || '';
      const request = { requestedAt: Date.now(), automationToken, roundToken: run.rounds && run.rounds.token };
      const promise = nativeFetch.apply(this, args);
      promise.then((response) => observeResponse(url, response, request)).catch(() => {});
      return promise;
    };

    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__arenaBillingUrl = url;
      this.__arenaBillingRequest = { requestedAt: Date.now(), automationToken, roundToken: run.rounds && run.rounds.token };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        const url = this.__arenaBillingUrl || '';
        if (!COST_ROUTE.test(String(url))) return;
        const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
        if (typeof text === 'string') setIdentifySource(sessionIdFromUrl(url) || currentSessionId(), text);
        const evidence = text ? extractCost(text) : null;
        if (evidence) onCost(sessionIdFromUrl(url) || currentSessionId(), evidence, Object.assign({ url: String(url), status: this.status }, this.__arenaBillingRequest || {}));
      });
      return send.apply(this, arguments);
    };
  }

  function scheduleCostFetch(sid, delay = MIN_COST_GAP_MS) {
    if (!run.owned || sid !== run.sessionId || costTimer) return;
    costTimer = setTimeout(async () => {
      costTimer = null;
      // ★★ R1（用户 2026-10-11 权威口径）：**取不到费用 = 观测缺失，不是「费用=0」**。
      //   · 旧实现在 `response.ok` 但响应里没有费用字段时**既不重试也不继续等** ⇒ 链条静默断掉，
      //     判定器可能在"什么都没冒出来"的那一轮就下结论（用户报的「还在加载……费用也没出来，
      //     它就已经结束了、直接归档」）。
      //     现在：ok 但无字段 与 HTTP 非 ok / 抛错 走**同一条**重试阶梯（阶梯长度不变，仍是 2 次重试）。
      //   · 阶梯耗尽后调 discardOwnedProbe ⇒ 定稿（evidenceFinal=true）⇒ 判定器按 R1 口径给
      //     PAUSE/NO_EVIDENCE ⇒ 暂停：不归档、不排队新探针、不新建会话。
      //     本函数**不直接**触发任何归档。
      const retry = (label) => {
        if (run.retries++ < 2) scheduleCostFetch(sid, MIN_COST_GAP_MS * (run.retries + 1));
        else void discardOwnedProbe('COST_UNAVAILABLE', label);
      };
      try {
        const response = await fetch(`/api/chat/${encodeURIComponent(sid)}/cost?includeSession=true`, { credentials: 'same-origin' });
        if (!response.ok) { retry('❌ 无账单/无法反推'); return; }
        const evidence = extractCost(await response.text());
        if (evidence) { onCost(sid, evidence, { url: response.url, status: response.status }); return; }
        retry('❌ 无账单/无法反推（HTTP 200 但响应无费用字段）');
      } catch (_) {
        retry('❌ 无账单/无法反推');
      }
    }, Math.max(delay, MIN_COST_GAP_MS));
  }
// ═══════════════════════════════════════════════════════════════════════════
  // 卡片 D′（t-mv233jwm-2qgyg7）：会话状态机（新口径）
  //   · 四分支：KEEP / ARCHIVE / WAIT / PAUSE（判定来自 A′ identifyPolicy，语义=成员关系）
  //   · K=0：判为 ARCHIVE 后**一条消息都不发**（账户里也不追辨识消息）
  //   · 逐轮复核：命中后每发一轮任务、每次 /cost 回调都重新跑判定，KEEP→ARCHIVE 立刻停手归档
  //   · 停止线（卡 G 改口径）：**默认不限**（探针条数 null、新增 charged null）；只有用户
  //     自设正数上限才在到线时停。判上限前先判 null —— Number(null)===0、null>=0 为真，
  //     把"不限"当 0 条是最容易犯的错。
  //   · 卡 G：删除「两条探针都未命中 ⇒ 暂停」这条专属规则（旧默认 2 条 = 旧规则），
  //     改成未命中（POOL_MISS/NO_COMPLETE/NO_EVIDENCE）留证→改名→归档→确认成功 ⇒ 自动继续；
  //     暂停只留：人工停止 / 人机验证 / 探针耗尽 / 归档失败 / 配置无效 / 用户自设上限 /
  //     thinking 策略要求暂停（外加两条操作性失败：建会话失败、任务发不出——都不是搜索停止线）。
  //     ★ 0.6.3：探针池改成"一轮用尽自动轮换"后，**"探针耗尽"不再是暂停原因**（只剩
  //       "池本身不可用/为空"的兜底停机，reason 仍沿用历史值 PROBE_EXHAUSTED 以便兼容存档）。
  //   · 自动命名：按 key 字典序的第一个候选（`≈ {disp}` / `≈ {disp}（另有{N}候选）` /
  //     `❌ 池外：{disp}（另有{N}候选）` / `❌ 无可验证候选` / `❌ 思考流不符：{disp}`，
  //     另有 NO_EVIDENCE 的 `❌ 费用证据不足`），48 个可见字符上限
  //   · 开关一「按候选池固定筛选」（默认关）；开关二「思考流要求」三态（默认不管）
  //
  // 判定输入：A′ identifyPolicy(report, { poolKeys, poolCatalogHash, runningCatalogHash,
  //   knownCatalogKeys, evidenceFinal })；归档出口：E archiveAndVerify(sid, { name })。
  // 本部件**不再调用**旧 classify() / fitCandidate()（留在 20-network.js，归卡片 E），
  // 也**不再直接调用** archiveOwnedSession()。
  //
  // 两张表（唯一事实来源，逐字对应 falsify/evidence/t-mv233jwm-2qgyg7/）：
  //   ① 状态转移表（decision × 事件 ⇒ 动作）   → 01-state-transition-table.md
  //   ② thinking 组合表（固定筛选 × 思考流要求 × 已见/未见 ⇒ 动作） → 02-thinking-combination-table.md
  // 固定执行顺序：① 执行约束 → ②（固定筛选开启时才作门禁的）池判定 → ③ thinking 要求 → ④ 继续/暂停/归档
  //
  // 偏好与名单配置的**落盘归 B′**（parts/15-state.js）；本部件只读，缺省即默认值。
  // ★ B′ 已落地 ⇒ 首选真来源（同一 IIFE 作用域，直接读，绝不写回）：
  //   targetPoolFixedFilterEnabled()       → 固定筛选（恒 true；本部件不读任何可被旧值污染的字段）
  //   targetPoolState.thoughtRequirement   → 唯一偏好（'any'|'require'|'avoid' ⇒ 不管|要|不要）
  //   targetPoolEffectiveKeys()            → 本次名单（恒定 = 内嵌固定名单 7 条 key）
  //   targetPoolTitle() / targetPoolRunningCatalogHash()
  //   兼容路径（B′ 未落地时的自造同形桩）：config.thinkingRequirement /
  //   config.poolKeys / config.poolPresetId / config.poolPresets。
  // ★ 已删除的旧读法（卡 t-mv2j1g19-kkt8dv）：targetPoolState.filterEnabled、
  //   config.fixedFilter、config.poolFixedFilter、targetPoolState.presetIds、targetPoolIsCustom()。
  //   它们让"关掉固定筛选"成为可能 ⇒ 默认配置下决策层恒 KEEP ⇒ 永远不会自动归档（用户报的缺陷）。
  // 目录哈希口径：A′ 只在 poolCatalogHash 与 runningCatalogHash **都非空且不等**时判 POOL_INVALID，
  //   而 A′ 自己的测试把 __IDENTIFY_BUILD__.bundleHash 同时当这两个值 ⇒ 本部件默认两者同源同值
  //   （config.poolCatalogHash 可显式覆盖成"池是用哪个目录版本选的"）；B′ 的 sourceSha256 只作参考字段。
  // 中途改控件（B′ 的控件层 effects 恒为空、不回调本卡）⇒ 本部件在下一次判定事件里**被动发现**：
  //   开关变了 ⇒ 暂停后续自动发送 + 重判已有证据（不归档、不发消息，恢复后按新规则执行）；
  //   池变了   ⇒ 就地重判 + 取消尚未发送的任务，并**只重锁池**（探针/金额上限不动）。
  // 面板显示归 B′（parts/40-panel.js）；本部件只把字段挂在 run 上（见文件末尾 automationStatusLines），
  // 另用一次 renderStatus 包装做临时显示（与 C 卡同样做法，B′ 接线后可删）。
  // ═══════════════════════════════════════════════════════════════════════════

  const AUTOMATION_STATE_STORAGE = 'arena-agent-billing:automation:v1';
  const AUTOMATION_EVIDENCE_STORAGE = 'arena-agent-billing:automation-evidence:v1';
  const AUTOMATION_EVIDENCE_MAX = 20;
  const AUTOMATION_NAME_MAX_VISIBLE = 48;
  const AUTOMATION_REFETCH_MAX = 2;
  // ★ 卡 G：默认**不限**（null = 不限）。判上限前必须先判 null，不能把 null 当 0。
  const AUTOMATION_PROBE_LIMIT_DEFAULT = null;
  const AUTOMATION_CHARGED_LIMIT_DEFAULT = null;
  const AUTOMATION_LAUNCH_FAILURE_MAX = 3;
  const AUTOMATION_THINKING_MODES = ['不管', '要', '不要'];
  // ★ 0.6.3：探针池改成"一轮用尽自动轮换"后，**"用尽"不再是停止原因**；这条文案只保留给
  //   "池本身不可用/为空"的兜底停机（真正的异常）。旧口径（卡 G：32 条无放回、耗尽即停）已废弃。
  const AUTOMATION_PROBE_EXHAUSTED_MESSAGE = '探针池不可用（池内 0 条），已暂停新增探针';
  // 卡 G：连续未命中每 N 次更新一次提示（只更新提示，**不暂停**）。
  const AUTOMATION_MISS_NOTICE_EVERY = 10;
  // 卡 t-mv2j1g19-kkt8dv：折叠摘要里的固定名单简称（旧版是 Opus/GPT/全价/自选，随预设多选一起下线）。
  const AUTOMATION_POOL_SHORT = { targets: '目标' };
  const TARGET_ID_FALLBACK = 'targets';
  // 面板折叠态 / 位置（跨刷新恢复）与上限输入的本地记忆键。
  const AUTOMATION_PANEL_STORAGE = 'arena-agent-billing:panel:v1';
  const AUTOMATION_LIMIT_INVALID_HINT = '上限必须是正数；留空 = 不限，本次输入已忽略';
  // 名单固定 ⇒ 这两句只在**配置被外部破坏**时出现（防御分支，正常路径走不到）。
  const AUTOMATION_POOL_PROMPT = '内嵌名单不可用（配置异常）';
  const AUTOMATION_NAME_PREFIX = {
    KEEP: '≈ ',
    POOL_MISS: '❌ 池外：',
    NO_COMPLETE: '❌ 无可验证候选',
    NO_EVIDENCE: '❌ 费用证据不足',
    THINKING: '❌ 思考流不符：',
  };

  // ── 模块内可替换引用 ────────────────────────────────────────────────────────
  // 测试把下面这些换成假实现（automationTestApi.set*）；生产里指向真函数。
  // 刻意用 let + 包装函数：既保留 20-network.js 里那些函数的原始字节，又让本部件可离线断言。
  let automationFetchCostOnce = async function automationFetchCostOnceImpl(sid) {
    // 只读：GET /api/chat/<sid>/cost（与页面自己用的同一个端点，不写任何东西）。
    // 用 nativeFetch（顶部抓到的原生 fetch）⇒ 自己的只读请求不会被网络钩子当成页面回调，
    // 避免「读一次 → 钩子回调 → 再读一次」的回环。
    const response = await nativeFetch(`/api/chat/${encodeURIComponent(sid)}/cost?includeSession=true`, { credentials: 'same-origin' });
    let text = '';
    try { text = await response.text(); } catch (_) { text = ''; }
    return { ok: !!response.ok, status: response.status, text };
  };
  let automationArchiveAndVerify = (sid, options) => archiveAndVerify(sid, options);
  let automationSendText = (text) => sendText(text);
  let automationIdentifyReport = (json) => identifyReport(json);
  let automationIdentifyPolicy = (report, opts) => identifyPolicy(report, opts);
  let automationRenameForArchive = (sid, name, steps) => renameForArchive(sid, name, steps);
  let automationRename = (name) => renameOwnedSession(name);
  let automationStopGeneration = () => stopGeneration();
  let automationNotify = (message) => notify(message);
  let automationHumanVerificationVisible = () => humanVerificationVisible();
  let automationIsGenerating = function automationIsGeneratingImpl() {
    // 「本轮是否还在生成」只看页面上的停止按钮（与 stopGeneration 同一套选择器）。
    // 判定不了就当"没在生成"（保守：宁可早结算，也不把轮次卡死）。
    try {
      return [...document.querySelectorAll('button,[role="button"]')]
        .filter(isVisible)
        .some((el) => /stop|停止|cancel generation|中止/i.test(textOf(el)));
    } catch (_) { return false; }
  };
  let automationUseIntlSegmenter = true;
  const automationTiming = {
    probeGapMs: PROBE_RETRY_GAP_MS,
    costGapMs: MIN_COST_GAP_MS,
    roundGapMs: MIN_COST_GAP_MS,
    generateWaitMax: 3,
  };
  let automationBusy = false;
  let automationPendingRecheck = null;

  // ── 纯函数①：可见字符 / 命名 ───────────────────────────────────────────────

  /** 目录行 key 的比较器：UTF-16 码元序（**不用 localeCompare**，与 A′ 同一口径、与输入顺序无关）。 */
  function automationKeyCompare(a, b) {
    const x = String(a == null ? '' : a);
    const y = String(b == null ? '' : b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  /** 组合字符 / emoji 兜底切分：基字符 + 组合记号 + VS + 肤色 + ZWJ 串 + 区域指示符对 + keycap + tag。 */
  function automationFallbackClusters(text) {
    const points = [...String(text == null ? '' : text)];
    const out = [];
    const isMark = (ch) => /[\p{M}\uFE0F\u20E3]/u.test(ch);
    const isTag = (ch) => ch >= '\u{E0020}' && ch <= '\u{E007F}';
    const isSkin = (ch) => ch >= '\u{1F3FB}' && ch <= '\u{1F3FF}';
    const isRegional = (ch) => ch >= '\u{1F1E6}' && ch <= '\u{1F1FF}';
    let i = 0;
    while (i < points.length) {
      let cluster = points[i];
      i += 1;
      if (isRegional(cluster) && i < points.length && isRegional(points[i])) { cluster += points[i]; i += 1; }
      for (;;) {
        if (i >= points.length) break;
        const next = points[i];
        if (isMark(next) || isTag(next) || isSkin(next)) { cluster += next; i += 1; continue; }
        if (next === '\u200D' && i + 1 < points.length) { cluster += next + points[i + 1]; i += 2; continue; }
        break;
      }
      out.push(cluster);
    }
    return out;
  }

  /** 可见字符切分：优先 Intl.Segmenter（grapheme），不可用/被测试关掉时用兜底实现。 */
  function automationClusters(text) {
    const source = String(text == null ? '' : text);
    if (!source) return [];
    if (automationUseIntlSegmenter) {
      try {
        const Segmenter = (typeof Intl !== 'undefined' && Intl && typeof Intl.Segmenter === 'function') ? Intl.Segmenter : null;
        if (Segmenter) {
          const segmenter = new Segmenter('zh', { granularity: 'grapheme' });
          const out = [];
          for (const piece of segmenter.segment(source)) out.push(piece.segment);
          if (out.length) return out;
        }
      } catch (_) { /* 降级到兜底实现 */ }
    }
    return automationFallbackClusters(source);
  }

  function automationVisibleLength(text) {
    return automationClusters(text).length;
  }

  function automationCutClusters(text, budget) {
    const clusters = automationClusters(text);
    const keep = Math.max(0, Math.floor(Number(budget) || 0));
    if (keep >= clusters.length) return String(text == null ? '' : text);
    return clusters.slice(0, keep).join('');
  }

  /**
   * 名字 = 前缀 + disp + 后缀，**上限 48 个可见字符**：超限只截中间的 disp 并补 `…`，
   * 前缀与「（另有N候选）」后缀原样保留；按可见字符切，不切断 emoji / 组合字符。
   */
  function automationComposeName(prefix, disp, suffix, maxVisible) {
    const limit = Math.max(8, Math.floor(automationNumber(maxVisible, AUTOMATION_NAME_MAX_VISIBLE) || AUTOMATION_NAME_MAX_VISIBLE));
    const head = String(prefix == null ? '' : prefix);
    const middle = String(disp == null ? '' : disp);
    const tail = String(suffix == null ? '' : suffix);
    if (automationVisibleLength(head + middle + tail) <= limit) return head + middle + tail;
    let keepTail = tail;
    let budget = limit - automationVisibleLength(head) - automationVisibleLength(keepTail) - 1;
    if (budget < 1) { keepTail = ''; budget = limit - automationVisibleLength(head) - 1; }
    if (budget < 1) return automationCutClusters(head, limit);   // 病态：连前缀都放不下
    return head + automationCutClusters(middle, budget) + '…' + keepTail;
  }

  function automationCompleteRows(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.complete)) return [];
    return report.complete.filter((row) => row && typeof row === 'object' && !Array.isArray(row)
      && typeof row.key === 'string' && row.key);
  }

  /**
   * 命名候选集合（清单 21/22）：
   *   · 命中名单 ⇒ matchedKeys 对应的 complete 候选（**与判定同一份 matchedKeys**，不另算一遍）；
   *   · matchedKeys 为空（归档路径：POOL_MISS / NO_COMPLETE）⇒ 全部 complete 候选 ——
   *     归档名要能说清"实际抓到的是什么"，所以这时不能用名单内集合；
   *   · 一律按 key 的确定性字典序排序（自己排，**不依赖 A′ 返回顺序**）。
   * ★ 本版 fixedFilter 恒 true（见 automationSwitches）：上面的分支退化成一个判断 ——
   *   「matchedKeys 有就用它、没有就用全部」，不会再出现"筛选关闭 ⇒ 恒用全部"的旧路径。
   */
  function automationNameCandidates(report, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const rows = automationCompleteRows(report);
    const matched = Array.isArray(options.matchedKeys) ? options.matchedKeys : [];
    const useMatched = options.fixedFilter === true && matched.length > 0;
    const filtered = useMatched ? rows.filter((row) => matched.includes(row.key)) : rows;
    return filtered
      .map((row) => ({ key: row.key, disp: typeof row.disp === 'string' && row.disp ? row.disp : '' }))
      .sort((a, b) => automationKeyCompare(a.key, b.key));
  }

  function automationDispOf(candidate) {
    if (!candidate) return '';
    return candidate.disp || candidate.key || '';
  }

  /** outcome ⇒ 名称（清单 21 的五种格式 + NO_EVIDENCE 的「❌ 费用证据不足」）。 */
  function automationNameFor(outcome, candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (outcome === 'NO_COMPLETE') return AUTOMATION_NAME_PREFIX.NO_COMPLETE;
    if (outcome === 'NO_EVIDENCE') return AUTOMATION_NAME_PREFIX.NO_EVIDENCE;
    const prefix = AUTOMATION_NAME_PREFIX[outcome] || AUTOMATION_NAME_PREFIX.KEEP;
    if (!list.length) {
      if (outcome === 'POOL_MISS') return AUTOMATION_NAME_PREFIX.POOL_MISS + '无可验证候选';
      if (outcome === 'THINKING') return AUTOMATION_NAME_PREFIX.THINKING + '无可验证候选';
      return null;   // KEEP 且没有候选 ⇒ 保留原名（面板「暂无法按价格命名」）
    }
    const disp = automationDispOf(list[0]);
    const extra = list.length - 1;
    const suffix = (outcome !== 'THINKING' && extra > 0) ? `（另有${extra}候选）` : '';
    return automationComposeName(prefix, disp, suffix, AUTOMATION_NAME_MAX_VISIBLE);
  }

  function automationNameOutcome(reason) {
    if (reason === 'POOL_MISS') return 'POOL_MISS';
    if (reason === 'NO_COMPLETE') return 'NO_COMPLETE';
    if (reason === 'NO_EVIDENCE') return 'NO_EVIDENCE';
    if (reason === 'THINKING_MISMATCH' || reason === 'THINKING_PRESENT') return 'THINKING';
    return 'POOL_MISS';
  }

  // ── 纯函数②：thinking 观测与决策（清单 26/27/28） ──────────────────────────

  function automationNormalizeThinkingMode(value) {
    const text = String(value == null ? '' : value).trim();
    if (text === '要' || text === 'require' || text === 'required') return '要';
    if (text === '不要' || text === 'forbid' || text === 'forbidden' || text === 'avoid') return '不要';
    return '不管';
  }

  const AUTOMATION_OBSERVED_STATES = ['PENDING', 'SEEN', 'NOT_SEEN', 'UNKNOWN'];

  /**
   * ★★ R2 常量 · thinking 恒定中断 + 归档（用户 2026-10-11 权威口径）
   *
   * 用户原话：「页面出现 think / thought / thinking 的时候，立刻中断，然后归档。」
   * （旧缺陷：默认三态「不管」在决策层**直接 return** ⇒ thinking 永远不中断、不归档，
   *   现场症状正是用户报的「thinking 不中断」。）
   *
   * ⇒ 本条规则**恒定生效、不受三态开关影响**：只要观测态 = SEEN（SSE 里出现过
   *    reasoning/thinking/thought 类型事件）就 stopGeneration + archive。
   *
   * ★ 一键回退点（唯一一处）：把下面这一行改成 `false` ⇒ 立刻退回旧三态表
   *   （不管=不触发 / 要=按观测 / 不要=命中才中断+归档），**不需要改任何其它代码**。
   *
   * ⚠️ 已知副作用（GPT 顾问与总工共同标注，必须知情）：若**目标模型自身也产出** thinking/thought，
   *   本条规则会把目标会话也中断并归档（误归档）。真机若发现目标会话被误归档 ⇒ 立即停卡报告，
   *   并把本常量改回 `false`。
   */
  const AUTOMATION_THINKING_ALWAYS_ARCHIVE = true;

  /**
   * 命中原文 + 来源（R2 要求「必须记录命中原文与来源」）。
   * markers 是 SSE 事件里匹配到 THOUGHT_TYPE 的**原始类型片段**（如 reasoning-delta / thought）；
   * source 记录命中通道：'sse'（20-network.js 的 think 流扫描）——本版**没有** DOM 文本通道。
   */
  function automationThinkingHitDetail(thinking) {
    const t = thinking && typeof thinking === 'object' ? thinking : {};
    const markers = Array.isArray(t.markers) ? t.markers.filter((m) => typeof m === 'string' && m) : [];
    return { markers: markers.slice(0, 8), source: typeof t.source === 'string' && t.source ? t.source : 'unknown' };
  }

  function automationThinkingObservedState(thinking) {
    const state = thinking && typeof thinking === 'object' ? thinking.state : null;
    return AUTOMATION_OBSERVED_STATES.includes(state) ? state : 'UNKNOWN';
  }

  /**
   * 决策层（纯函数）：固定筛选 × 思考流要求 × 观测态 ⇒ 动作。
   * 返回 { action:'continue'|'pause'|'archive', stopGeneration, reason, notice }。
   * 组合表见 falsify/evidence/t-mv233jwm-2qgyg7/02-thinking-combination-table.md。
   */
  function automationThinkingDecision(input) {
    const opts = input && typeof input === 'object' ? input : {};
    const gateOn = opts.fixedFilter === true;
    const mode = automationNormalizeThinkingMode(opts.thinkingMode);
    const state = automationThinkingObservedState(opts.thinking);
    const out = { action: 'continue', stopGeneration: false, state, mode, reason: null, notice: null };
    // ★★ R2（用户 2026-10-11，恒定规则，**优先于三态表**）：一旦观测到思考流就立刻停止生成并归档。
    //    这正是不受 mode 影响的那条规则；回退点见 AUTOMATION_THINKING_ALWAYS_ARCHIVE 上方注释。
    if (AUTOMATION_THINKING_ALWAYS_ARCHIVE === true && state === 'SEEN') {
      const hit = automationThinkingHitDetail(opts.thinking);
      out.stopGeneration = true;
      out.action = 'archive';
      out.reason = 'THINKING_PRESENT';
      out.notice = '检测到思考流（恒定规则：不受「思考流要求」三态开关影响）：已停止生成并归档；'
        + `命中原文=${hit.markers.join('、') || '（未记录）'}；来源=${hit.source}`;
      return out;
    }
    if (mode === '不管') return out;                       // 不触发
    if (mode === '要') {
      if (state === 'SEEN') return out;                    // 满足
      if (state === 'PENDING') { out.reason = 'THINKING_PENDING'; return out; }
      if (state === 'UNKNOWN') {
        // ★ UNKNOWN 绝不能当成「没有」⇒ 暂停并保留
        out.action = 'pause';
        out.reason = 'THINKING_UNKNOWN';
        out.notice = '思考流观测不完整（UNKNOWN），不能当作「没有」；已暂停并保留会话（未归档、未新建）';
        return out;
      }
      if (gateOn) { out.action = 'archive'; out.reason = 'THINKING_MISMATCH'; return out; }
      out.action = 'pause';
      out.reason = 'THINKING_MISSING';
      out.notice = '本轮未观测到思考流（开关一关闭：只暂停后续自动发送，不归档）';
      return out;
    }
    // mode === '不要'
    if (state === 'SEEN') {
      out.stopGeneration = true;                           // 一旦 SEEN 立即停止生成（不等费用结算）
      if (gateOn) { out.action = 'archive'; out.reason = 'THINKING_PRESENT'; return out; }
      out.action = 'pause';
      out.reason = 'THINKING_PRESENT';
      out.notice = '检测到思考流并已停止生成（开关一关闭：只暂停后续自动发送，不归档）';
      return out;
    }
    if (gateOn) { out.reason = 'THINKING_NOT_SEEN_OK'; return out; }
    out.reason = 'THINKING_NOT_SEEN_OK';
    return out;
  }

  // ── 偏好 / 名单配置（只读 B′；本版只剩"思考流要求"这一项偏好） ──────────────

  /**
   * 当前偏好（**只读**）。
   * ★ 卡 t-mv2j1g19-kkt8dv 起：真来源是 parts/15-state.js 的 `targetPoolState`
   *   = { targetId, filterEnabled, thoughtRequirement, legacy }，
   *   thoughtRequirement ∈ B′ 的 THOUGHT_REQUIREMENTS = ['any','require','avoid']
   *   （any=不管 / require=要 / avoid=不要）。**本卡只读，绝不写回**。
   * ★ fixedFilter **恒为 true**（常量，不是配置）：
   *   旧版这里是 `targetPoolState.filterEnabled === true` 与兼容路径
   *   `config.fixedFilter === true || config.poolFixedFilter === true`，
   *   而默认值是 false ⇒ 默认配置下决策层恒为 KEEP ⇒ **永远不会自动归档**（用户报的缺陷）。
   *   这两条读法都已删除：名单固定 = 固定筛选恒开，没有任何入口能把它关掉。
   * 兼容路径（仅思考流一项）：B′ 不可用时读 config（自造同形桩 / 测试注入）。
   */
  function automationSwitches() {
    const out = { fixedFilter: true, thinkingMode: '不管', source: 'fixed' };
    // 单一事实来源是 B′ 的 TARGET_POOL_FIXED_FILTER（恒 true）；这里做一次只读转发，
    // 拿不到函数时退化为常量 true —— 两条路都**不可能**得到 false。
    try {
      if (typeof targetPoolFixedFilterEnabled === 'function') out.fixedFilter = targetPoolFixedFilterEnabled() === true;
    } catch (_) {}
    try {
      if (typeof targetPoolState === 'object' && targetPoolState) {
        out.thinkingMode = automationNormalizeThinkingMode(targetPoolState.thoughtRequirement);
        out.source = 'targetPoolState';
      } else {
        out.thinkingMode = automationNormalizeThinkingMode(
          config.thinkingRequirement !== undefined ? config.thinkingRequirement : config.thinkingMode
        );
        out.source = 'config';
      }
    } catch (_) {
      try {
        out.thinkingMode = automationNormalizeThinkingMode(
          config.thinkingRequirement !== undefined ? config.thinkingRequirement : config.thinkingMode
        );
        out.source = 'config';
      } catch (_) {}
    }
    return out;
  }

  /** 两个开关是否与"本轮开始时记下的值"不同（用户中途改了开关）。 */
  function automationSwitchesChanged() {
    const live = automationSwitches();
    const seen = run.switches && typeof run.switches === 'object' ? run.switches : null;
    if (!seen) return false;
    return seen.fixedFilter !== live.fixedFilter || seen.thinkingMode !== live.thinkingMode;
  }

  /** 本批锁定的池是否与"当前池"不同（用户中途改了池）。 */
  function automationPoolChanged() {
    if (!run.batch || !Array.isArray(run.batch.poolKeys)) return false;
    const live = automationPoolSelection();
    if (!Array.isArray(live.keys)) return false;
    const a = run.batch.poolKeys;
    const b = live.keys;
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i += 1) { if (a[i] !== b[i]) return true; }
    return false;
  }

  function automationPoolPresets() {
    try {
      if (config && config.poolPresets && typeof config.poolPresets === 'object') return config.poolPresets;
    } catch (_) {}
    try {
      if (typeof window !== 'undefined' && window && window.__ARENA_AGENT_BILLING_POOL_PRESETS__) {
        return window.__ARENA_AGENT_BILLING_POOL_PRESETS__;
      }
    } catch (_) {}
    return null;
  }

  /**
   * 本次生效名单（**只读**）：
   * ★ 卡 t-mv2j1g19-kkt8dv 起：首选 parts/15-state.js 的 `targetPoolEffectiveKeys()`
   *   —— 它**恒定**返回内嵌固定名单的 7 条 key（与 state 无关，旧值里的 presetIds / rowKeys
   *   再也换不掉它）；标题取 `targetPoolTitle()`（恒定）。
   *   名单恒非空 ⇒ 正常路径走不到 POOL_EMPTY / POOL_INVALID（保留为防御分支）。
   * 兼容路径：config.poolKeys / config.poolPresetId / data/target-pool-presets.json 形状。
   * 目录哈希：A′ 的契约是「**名单哈希与运行中哈希都取同一个目录身份**」，A′ 自己的测试里两者都传
   * `__IDENTIFY_BUILD__.bundleHash` ⇒ 本卡默认两者同源同值（config.poolCatalogHash 可显式覆盖），
   * 这样才能真正发现"名单是用旧目录版本选的"（不信 B′ 的 sourceSha256 当名单哈希 —— 那是另一种口径）。
   */
  function automationPoolSelection() {
    const presets = automationPoolPresets();
    const list = presets && Array.isArray(presets.presets) ? presets.presets : [];
    const out = {
      keys: null, catalogHash: null, version: null, title: null,
      targetId: null, presetCount: list.length, custom: false, source: 'none',
    };
    try {
      if (typeof targetPoolEffectiveKeys === 'function') {
        const keys = targetPoolEffectiveKeys();
        out.keys = Array.isArray(keys) ? keys.slice() : null;
        out.title = typeof targetPoolTitle === 'function' ? targetPoolTitle() : null;
        const state = typeof targetPoolState === 'object' && targetPoolState ? targetPoolState : null;
        out.targetId = state && typeof state.targetId === 'string' ? state.targetId : null;
        out.source = 'targetPoolState';
      }
    } catch (_) {}
    try {
      if (out.keys === null && Array.isArray(config.poolKeys)) out.keys = config.poolKeys.slice();
    } catch (_) {}
    try {
      const wanted = out.targetId !== null ? out.targetId
        : (config.poolPresetId !== undefined ? config.poolPresetId : config.poolId);
      if (wanted !== undefined && wanted !== null && wanted !== '') {
        const id = String(wanted);
        if (out.targetId === null) out.targetId = id;
        const preset = list.find((item) => item && String(item.id) === id) || null;
        if (preset) {
          if (out.title === null) out.title = preset.title || null;
          if (out.keys === null) out.keys = Array.isArray(preset.keys) ? preset.keys.slice() : null;
        }
      }
    } catch (_) {}
    try {
      if (typeof config.poolCatalogHash === 'string' && config.poolCatalogHash) out.catalogHash = config.poolCatalogHash;
    } catch (_) {}
    // ★ 与 runningCatalogHash 同源同值（A′ 契约）；显式配置优先。
    if (!out.catalogHash) out.catalogHash = automationRunningCatalogHash();
    try {
      if (config.poolVersion !== undefined && config.poolVersion !== null) out.version = config.poolVersion;
    } catch (_) {}
    if (out.version === null && presets && presets.version !== undefined && presets.version !== null) out.version = presets.version;
    // B′ 的 sourceSha256 只当**参考字段**记录，不冒充池哈希（口径不同，比了会误判 POOL_INVALID）。
    try {
      out.catalogSourceSha256 = typeof targetPoolRunningCatalogHash === 'function' ? targetPoolRunningCatalogHash() : null;
    } catch (_) { out.catalogSourceSha256 = null; }
    if (out.title === null && presets && typeof presets.title === 'string') out.title = presets.title;
    return out;
  }

  function automationKnownCatalogKeys() {
    try {
      if (Array.isArray(IDENTIFY_CATALOG)) {
        return IDENTIFY_CATALOG.map((row) => row && row.key).filter((key) => typeof key === 'string' && key);
      }
    } catch (_) {}
    return null;   // 拿不到目录就不做"表外 key"校验（不猜、不伪造）
  }

  function automationRunningCatalogHash() {
    try {
      if (__IDENTIFY_BUILD__ && typeof __IDENTIFY_BUILD__.bundleHash === 'string') return __IDENTIFY_BUILD__.bundleHash;
    } catch (_) {}
    return null;
  }

  function automationPolicyOptions(extra) {
    const pool = automationPoolSelection();
    const base = {
      poolKeys: Array.isArray(pool.keys) ? pool.keys.slice() : null,
      poolCatalogHash: pool.catalogHash,
      runningCatalogHash: automationRunningCatalogHash(),
      knownCatalogKeys: automationKnownCatalogKeys(),
      evidenceFinal: run.evidenceFinal === true,
    };
    return extra && typeof extra === 'object' ? Object.assign(base, extra) : base;
  }

  function automationPolicySummary(policy) {
    if (!policy || typeof policy !== 'object') return null;
    return {
      decision: policy.decision,
      reason: policy.reason,
      matchedKeys: Array.isArray(policy.matchedKeys) ? policy.matchedKeys.slice() : [],
      completeCount: Number(policy.completeCount) || 0,
      unconstrainedCount: Number(policy.unconstrainedCount) || 0,
      ignoredCount: Number(policy.ignoredCount) || 0,
      limitations: Array.isArray(policy.limitations) ? policy.limitations.slice() : [],
      message: typeof policy.message === 'string' ? policy.message : null,
    };
  }

  /** 调 A′（可注入）。返回形状固定七字段 + message；拿不到就退化成 WAIT（下一次重取）。 */
  function automationPolicy(report, extra) {
    const options = automationPolicyOptions(extra);
    run.lastPolicyOptions = options;
    let result = null;
    try { result = automationIdentifyPolicy(report, options); } catch (_) { result = null; }
    if (!result || typeof result !== 'object' || !result.decision) {
      result = {
        decision: 'WAIT', reason: 'IDENTIFY_POLICY_UNAVAILABLE', matchedKeys: [],
        completeCount: 0, unconstrainedCount: 0, ignoredCount: 0, limitations: [],
        message: '判定器不可用，按等待处理',
      };
    }
    const summary = automationPolicySummary(result);
    run.policy = summary;
    run.decision = summary.decision;
    run.verdict = { label: `池判定 ${summary.decision}`, reason: summary.reason, matches: [], competitors: [] };
    run.poolAdvisory = `${summary.decision}/${summary.reason}`;
    return summary;
  }

  // ── 本地状态 / 留证 / 导出（清单 15/16/17） ────────────────────────────────

  function automationNumber(value, fallback) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return fallback === undefined ? null : fallback;
  }

  function automationEnsureState() {
    if (!Array.isArray(run.currentRunOwned)) run.currentRunOwned = [];
    if (!Array.isArray(run.archivedSids)) run.archivedSids = [];
    if (!Array.isArray(run.terminatedSids)) run.terminatedSids = [];
    if (!Array.isArray(run.trace)) run.trace = [];
    if (!Array.isArray(run.hitSids)) run.hitSids = [];
    if (!run.chargedBySid || typeof run.chargedBySid !== 'object') run.chargedBySid = {};
    if (!run.thinking || typeof run.thinking !== 'object') {
      run.thinking = { state: 'UNKNOWN', round: null, kind: null, markers: [], complete: false };
    }
    if (!Array.isArray(run.thinking.markers)) run.thinking.markers = [];
    if (run.probesUsed === undefined || run.probesUsed === null) run.probesUsed = 0;
    if (run.chargedUsd === undefined || run.chargedUsd === null) run.chargedUsd = 0;
    if (run.refetchUsed === undefined || run.refetchUsed === null) run.refetchUsed = 0;
    if (run.switches === undefined || run.switches === null) run.switches = automationSwitches();
    if (run.autoNameUnavailable === undefined) run.autoNameUnavailable = false;
    if (run.batchStopped === undefined) run.batchStopped = false;
    // ★ 卡 G：停止必须记录原因；连续未命中 / 命中次数是面板文案的数据源。
    if (run.batchStopReason === undefined) run.batchStopReason = null;
    if (run.missStreak === undefined || run.missStreak === null) run.missStreak = 0;
    if (run.hitCount === undefined || run.hitCount === null) run.hitCount = 0;
    if (run.hitSids === undefined || run.hitSids === null) run.hitSids = [];
    return run;
  }

  // ── 卡 G：上限归一（null 语义 = 不限；绝不能把 null 当 0） ──────────────────

  /**
   * 上限归一：null / undefined / 空串 ⇒ **null（不限）**；正数或正数字符串 ⇒ 该正数；
   * 0 / 负数 / 非数字 / NaN / Infinity ⇒ null（面板会拦非法输入并提示，这里只做安全兜底）。
   * 注意 Number(null) === 0、Number('') === 0，所以必须先显式判空，不能用 Number() 直接兜。
   */
  function automationLimitValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return null;          // 布尔不是"正数输入"，不许被 Number(true)=1 蒙混
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  /** 面板/状态文案：null ⇒ 「不限」；数字 ⇒ 原样（不补零、不做 toFixed）。 */
  function automationLimitLabel(value) {
    const n = automationLimitValue(value);
    return n === null ? '不限' : String(n);
  }

  /** 本批探针条数上限（null = 不限）。 */
  function automationProbeLimitOf(batch) {
    const b = batch && typeof batch === 'object' ? batch : (run.batch || {});
    return automationLimitValue(b.probesLimit);
  }

  /** 本批 charged 上限（null = 不限）。 */
  function automationChargedLimitOf(batch) {
    const b = batch && typeof batch === 'object' ? batch : (run.batch || {});
    return automationLimitValue(b.chargedLimitUsd);
  }

  /** 面板输入归一：字符串/数字 ⇒ { ok, value }；非法输入 ok:false（不写坏状态）。 */
  function automationLimitInput(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: null, unlimited: true };
    if (typeof raw === 'boolean') return { ok: false, value: null, unlimited: false };
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '') return { ok: true, value: null, unlimited: true };
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, value: null, unlimited: false };
    return { ok: true, value: n, unlimited: false };
  }

  /**
   * 面板改上限（卡 G）：空 = 不限（写 null 并落盘）；非法输入（0 / 负数 / 非数字）⇒ **不改状态**、
   * 返回 ok:false + 提示文案。已锁定的本批上限不回改（锁在 automationLockBatch；只影响下一批）。
   */
  function automationSetLimit(field, raw) {
    if (field !== 'probeLimit' && field !== 'chargedLimitUsd') return { ok: false, error: 'BAD_FIELD' };
    const name = field === 'probeLimit' ? '探针上限' : '费用上限';
    const parsed = automationLimitInput(raw);
    if (parsed.ok !== true) {
      return {
        ok: false, error: 'NOT_POSITIVE', hint: AUTOMATION_LIMIT_INVALID_HINT,
        value: config[field] === undefined ? null : config[field],
      };
    }
    config[field] = parsed.value;
    try { save(); } catch (_) {}
    return {
      ok: true, unlimited: parsed.unlimited === true, value: parsed.value,
      label: name + '：' + automationLimitLabel(parsed.value),
    };
  }

  /**
   * ★ 卡 G · 旧配置迁移：**只**当两个值同时恰为旧默认（探针 2 条 + 费用 $0.10）时改成不限；
   * 任一自定义值都保留。**绝不**碰 probesUsed / chargedUsd（计数不重置）。
   * 幂等：迁移过一次之后再调不会有任何变化。
   */
  function automationMigrateLimits(targetConfig) {
    const cfg = targetConfig && typeof targetConfig === 'object' ? targetConfig : config;
    if (!cfg || typeof cfg !== 'object') return { migrated: false, reason: 'NO_CONFIG' };
    const p = cfg.probeLimit;
    const c = cfg.chargedLimitUsd;
    const present = p !== undefined && p !== null && c !== undefined && c !== null;
    const before = {
      probeLimit: p === undefined ? null : p,
      chargedLimitUsd: c === undefined ? null : c,
      probesUsed: cfg.probesUsed === undefined ? null : cfg.probesUsed,
      chargedUsd: cfg.chargedUsd === undefined ? null : cfg.chargedUsd,
    };
    if (!present) {
      return { migrated: false, reason: 'NOT_OLD_DEFAULT', before, after: before };
    }
    if (!(Number(p) === 2 && Number(c) === 0.1)) {
      return { migrated: false, reason: 'CUSTOM_KEPT', before, after: before };
    }
    cfg.probeLimit = null;
    cfg.chargedLimitUsd = null;
    try { if (cfg === config) save(); } catch (_) {}
    return {
      migrated: true, reason: 'OLD_DEFAULT_TO_UNLIMITED',
      before,
      after: { probeLimit: null, chargedLimitUsd: null },
    };
  }

  /** 探针池信息（C 卡 100 条池；池不在就返回 null，面板显示"不可用"而不是编造）。 */
  function automationProbePoolInfo() {
    try {
      if (typeof probePoolInfo === 'function') {
        const info = probePoolInfo();
        if (info && typeof info === 'object') {
          return {
            version: info.version === undefined ? null : info.version,
            total: Number(info.total) || 0,
            used: Number(info.used) || 0,
            remaining: Number(info.remaining) || 0,
            // ★ 0.6.3 轮换：轮次信息一并透出（面板"第 N 轮 / 本轮已用 x / 共 y / 累计 z"）
            cycle: Number(info.cycle) || 1,
            usedInCycle: Number(info.usedInCycle) || Number(info.used) || 0,
            usedTotal: Number(info.usedTotal) || 0,
            next: info.next ? { id: info.next.id, firstSentence: info.next.firstSentence } : null,
          };
        }
      }
    } catch (_) {}
    return null;
  }

  /** 池是否不可用（true 才兜底停机；★ 0.6.3 起"用尽"不是停机条件 —— 一轮用完会自动轮换）。 */
  function automationProbePoolExhausted() {
    try {
      if (typeof probePoolExhausted === 'function') return probePoolExhausted() === true;
    } catch (_) {}
    const info = automationProbePoolInfo();
    // 没有 probePoolExhausted() 的旧桩：只有池为空（不可用）才算异常；"本轮用尽"不算。
    return !!info && info.total === 0;
  }

  /**
   * ★ 0.6.3：取一条**未用过**的探针 —— 不限条数 ≠ 可以重用开场语。
   *   ① 有 C 的探针池（100 条轮内无放回 + 跨刷新持久化 + 一轮用尽自动轮换）⇒ probePoolDraw()；
   *      返回 null 只可能是**池为空**（异常兜底），不再是"用尽"。
   *   ② 池不可用（离线桩）⇒ 退化为 probeForAttempt()（config.probeText，仅兼容/测试用）。
   */
  function automationDrawProbe(attempt) {
    try {
      if (typeof probePoolDraw === 'function') {
        const drawn = probePoolDraw();
        if (drawn && typeof drawn.text === 'string' && drawn.text) {
          const info = automationProbePoolInfo();
          return {
            prompt: drawn.text, probeId: drawn.id || null, from: 'pool',
            firstSentence: drawn.firstSentence || null,
            index: info ? Math.max(0, info.used - 1) : 0,
            total: info ? info.total : 0,
            remaining: info ? info.remaining : null,
          };
        }
        return null;                                  // ★ 池为空（异常兜底）：不循环复用、不自动清空
      }
    } catch (_) {}
    const fallback = typeof probeForAttempt === 'function' ? probeForAttempt(attempt) : null;
    if (!fallback) return null;
    return {
      prompt: fallback.prompt, probeId: null, from: 'config', firstSentence: null,
      index: fallback.index, total: fallback.total, remaining: null,
    };
  }

  /** 提示/面板用的短标签（探针正文是短素材，但也绝不整段塞进提示）。 */
  function automationProbeShortLabel(selected) {
    if (!selected) return '（无）';
    const head = selected.firstSentence
      ? String(selected.firstSentence).replace(/\s+/g, ' ').trim().slice(0, 40)
      : String(selected.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return (selected.probeId ? selected.probeId + ' · ' : '') + head + (head.length >= 40 ? '…' : '');
  }

  function automationPersist() {
    try {
      localStorage.setItem(AUTOMATION_STATE_STORAGE, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        switches: automationSwitches(),
        batch: run.batch || null,
        probesUsed: Number(run.probesUsed) || 0,
        chargedUsd: Number(run.chargedUsd) || 0,
        chargedBySid: run.chargedBySid || {},
        decision: run.decision || null,
        policy: run.policy || null,
        poolAdvisory: run.poolAdvisory || null,
        thinking: run.thinking || null,
        sessionName: run.sessionName || null,
        autoNameUnavailable: run.autoNameUnavailable === true,
        notice: run.notice || null,
        batchStopped: run.batchStopped === true,
        batchStopReason: run.batchStopReason || null,
        batchStopMessage: run.batchStopMessage || null,
        missStreak: Number(run.missStreak) || 0,
        hitCount: Number(run.hitCount) || 0,
        hitSids: Array.isArray(run.hitSids) ? run.hitSids.slice() : [],
        archivedSids: run.archivedSids || [],
        terminatedSids: run.terminatedSids || [],
        evidenceCount: automationEvidenceList().length,
      }));
      return true;
    } catch (_) { return false; }
  }

  function automationEvidenceList() {
    try {
      const raw = localStorage.getItem(AUTOMATION_EVIDENCE_STORAGE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
      return [];
    } catch (_) { return []; }
  }

  /** 写入一条本地留证并**回读校验**：只有回读确认落地才返回 ok:true（清单 16 的"成功"）。 */
  function automationWriteEvidence(record) {
    try {
      const list = automationEvidenceList();
      list.push(record);
      const trimmed = list.slice(-AUTOMATION_EVIDENCE_MAX);
      localStorage.setItem(AUTOMATION_EVIDENCE_STORAGE, JSON.stringify({ version: 1, entries: trimmed }));
      const back = automationEvidenceList();
      const last = back.length ? back[back.length - 1] : null;
      if (!last || last.id !== record.id) return { ok: false, error: 'READBACK_MISMATCH' };
      return { ok: true, count: back.length };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function automationReportDigest(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
    return {
      verdict: report.verdict === undefined ? null : report.verdict,
      regime: report.regime && typeof report.regime === 'object' ? {
        standardMessages: report.regime.standardMessages,
        longContextMessages: report.regime.longContextMessages,
        longContextRule: report.regime.longContextRule,
      } : null,
      completeCount: automationCompleteRows(report).length,
      complete: automationCompleteRows(report).map((row) => ({
        key: row.key,
        disp: typeof row.disp === 'string' ? row.disp : null,
        org: row.org === undefined ? null : row.org,
        prices: row.prices === undefined ? null : row.prices,
      })),
      unconstrainedCount: Array.isArray(report.unconstrained) ? report.unconstrained.length : 0,
      ignored: report.ignored && typeof report.ignored === 'object' ? report.ignored : null,
    };
  }

  function automationBuildEvidenceRecord(sid, ctx, name, candidates) {
    const batch = run.batch || {};
    const policy = ctx && ctx.policy ? ctx.policy : run.policy;
    return {
      id: `${String(sid).slice(0, 8)}-${Date.now().toString(36)}`,
      at: Date.now(),
      atText: new Date().toISOString(),
      sid,
      decision: 'ARCHIVE',
      reason: ctx && ctx.reason ? ctx.reason : 'UNKNOWN',
      name,
      candidateKeys: (candidates || []).map((item) => item.key),
      candidates: (candidates || []).map((item) => ({ key: item.key, disp: item.disp || '' })),
      pool: {
        version: batch.poolVersion === undefined ? null : batch.poolVersion,
        presetId: batch.poolPresetId === undefined ? null : batch.poolPresetId,
        title: batch.poolTitle === undefined ? null : batch.poolTitle,
        keys: Array.isArray(batch.poolKeys) ? batch.poolKeys.slice() : [],
        poolCatalogHash: batch.poolCatalogHash === undefined ? null : batch.poolCatalogHash,
        runningCatalogHash: automationRunningCatalogHash(),
      },
      policy: policy ? {
        decision: policy.decision, reason: policy.reason,
        matchedKeys: Array.isArray(policy.matchedKeys) ? policy.matchedKeys.slice() : [],
        completeCount: policy.completeCount, unconstrainedCount: policy.unconstrainedCount,
        ignoredCount: policy.ignoredCount,
      } : null,
      report: automationReportDigest(ctx && ctx.report ? ctx.report : null),
      switches: automationSwitches(),
      thinking: run.thinking ? {
        state: run.thinking.state, round: run.thinking.round,
        markers: Array.isArray(run.thinking.markers) ? run.thinking.markers.slice() : [],
        // ★ R2：命中来源（'dom' = 页面上的 thinking 标签）也写进留证 —— 「记录命中原文与来源」要能复核。
        source: typeof run.thinking.source === 'string' ? run.thinking.source : null,
      } : null,
      chargedUsd: Number(run.chargedUsd) || 0,
      attempt: Number(run.attempt) || 0,
      probeIndex: Number(run.probeIndex) || 0,
    };
  }

  /** 人可读导出（清单 17）：审计「池外：<实际候选>」用。 */
  function automationEvidenceExportText() {
    const entries = automationEvidenceList();
    const lines = [`Arena 计费筛选 · 本地留证（${entries.length} 条；只在本地 localStorage，未上传）`];
    entries.forEach((entry, index) => {
      const pool = entry.pool || {};
      const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
      const actual = candidates.map((item) => (item.disp ? `${item.disp} [${item.key}]` : item.key)).join('、');
      lines.push('');
      lines.push(`[${index + 1}] ${entry.atText || new Date(entry.at || 0).toISOString()}　会话 ${entry.sid}`);
      lines.push(`    判定：${entry.decision}/${entry.reason}　名称：${entry.name || '—'}`);
      lines.push(`    池：${pool.title || '未命名候选池'}　version=${pool.version === undefined || pool.version === null ? '—' : pool.version}　target=${pool.targetId || '—'}　池内 key ${(pool.keys || []).length} 个`);
      lines.push(`    池外：${actual || '（本次没有 complete 候选）'}（complete 共 ${candidates.length} 个）`);
      lines.push(`    开关：固定筛选=${entry.switches && entry.switches.fixedFilter ? '开' : '关'}　思考流要求=${entry.switches ? entry.switches.thinkingMode : '—'}　观测=${entry.thinking ? entry.thinking.state : '—'}`);
      lines.push(`    费用：本次累计 $${(Number(entry.chargedUsd) || 0).toFixed(4)}　探针 #${entry.attempt || 0}`);
    });
    return lines.join('\n');
  }

  // ── run 上的显示字段 / 面板临时接线（40-panel.js 归 B′，这里只包 renderStatus） ──

  function automationStatusLines() {
    automationEnsureState();
    const switches = automationSwitches();
    const named = run.sessionName && run.sessionName.name ? run.sessionName.name : null;
    const archived = Array.isArray(run.archivedSids) ? run.archivedSids.length : 0;
    const pool = automationProbePoolInfo();
    const lines = [
      `自动：固定筛选=${switches.fixedFilter ? '开' : '关'} · 思考流要求=${switches.thinkingMode}`
      + ` · 命名=${named || (run.autoNameUnavailable ? '暂无法按价格命名' : '—')}`,
      `探针上限：${automationLimitLabel(automationProbeLimitOf())} · 费用上限：${automationLimitLabel(automationChargedLimitOf())}`,
      `本轮探测 ${Number(run.probesUsed) || 0} 次｜已归档 ${archived} 条｜命中 ${Number(run.hitCount) || 0} 次`,
      `剩余未用探针：${pool ? pool.remaining : '—'} 条`,
      // ★ 0.6.3：轮换进度（第 N 轮 / 本轮已用 x / 共 y / 累计 z）；池不可用时如实标注。
      automationPanelCycleLine(),
    ].filter(Boolean);
    // ★ 0.6.3：只有"池不存在 / 池内 0 条"才提示；"一轮用尽"会自动轮换，不再报耗尽。
    if (!pool || !pool.total) lines.push(AUTOMATION_PROBE_EXHAUSTED_MESSAGE);
    const streak = Number(run.missStreak) || 0;
    if (streak > 0) lines.push(`连续未命中 ${streak} 次，继续探测中`);
    if (run.decision) {
      lines.push(`判定：${run.decision}${run.policy && run.policy.reason ? `（${run.policy.reason}）` : ''}`
        + ` · 思考流观测：${run.thinking ? run.thinking.state : '—'}`
        + ` · 证据：${run.evidenceFinal ? '已定稿' : '等待中'}`);
    }
    if (run.poolAdvisory) lines.push(`池判定（参考）：${run.poolAdvisory}`);
    if (run.notice) lines.push(run.notice);
    if (run.batchStopMessage) lines.push(run.batchStopMessage);
    return lines;
  }

  // ── 卡 G：面板数据（纯函数；40-panel.js 直接调用，测试也能离线断言） ────────

  /** 上限两行（字面与卡片一致）：`探针上限：不限` / `费用上限：不限`。 */
  function automationPanelLimitsLines() {
    const p = config && config.probeLimit !== undefined ? config.probeLimit : null;
    const c = config && config.chargedLimitUsd !== undefined ? config.chargedLimitUsd : null;
    return [
      `探针上限：${automationLimitLabel(p)}`,
      `费用上限：${automationLimitLabel(c)}`,
    ];
  }

  /** 进度行：`本轮探测 {P} 次｜已归档 {A} 条｜命中 {H} 次`。 */
  function automationPanelProgressLine() {
    automationEnsureState();
    const archived = Array.isArray(run.archivedSids) ? run.archivedSids.length : 0;
    return `本轮探测 ${Number(run.probesUsed) || 0} 次｜已归档 ${archived} 条｜命中 ${Number(run.hitCount) || 0} 次`;
  }

  /** 剩余探针行：`剩余未用探针：{M} 条`（池不可用时如实标注，不编造数字）。 */
  function automationPanelRemainingLine() {
    const pool = automationProbePoolInfo();
    if (!pool || !pool.total) return '剩余未用探针：—（探针池不可用）';
    return `剩余未用探针：${pool.remaining} 条`;
  }

  /**
   * ★ 0.6.3 轮换进度行（逐字口径）：`第 N 轮 / 本轮已用 x / 共 y / 累计 z`。
   *   · 本轮刚好抽完时由 probePoolCycleLine() 补一句"下一条自动开第 N+1 轮"（不说"耗尽"）；
   *   · 池不可用（不存在 / 0 条）时返回 `探针轮次：—（探针池不可用）`（如实标注，不编造数字）。
   */
  function automationPanelCycleLine() {
    const pool = automationProbePoolInfo();
    if (!pool || !pool.total) return '探针轮次：—（探针池不可用）';
    try {
      if (typeof probePoolCycleLine === 'function') return '探针轮次：' + probePoolCycleLine();
    } catch (_) {}
    return `探针轮次：第 ${pool.cycle} 轮 / 本轮已用 ${pool.usedInCycle} / 共 ${pool.total} / 累计 ${pool.usedTotal}`;
  }

  /** 连续未命中提示行（只在 >0 时出现；**不暂停**）。 */
  function automationPanelMissLine() {
    const streak = Number(run.missStreak) || 0;
    return streak > 0 ? `连续未命中 ${streak} 次，继续探测中` : null;
  }

  /**
   * 本轮可验证候选预览（卡 G 清单 18）：**默认只给前 N 条（N=5）**，
   * 其余只报计数 —— 绝不默认倾倒几十行。
   */
  function automationCandidatesPreview(report, max) {
    const rows = automationCompleteRows(report);
    const n = Number(max);
    const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
    const shown = rows.slice(0, limit);
    return {
      title: '本轮可验证候选',
      total: rows.length,
      lines: shown.map((row) => `${row.disp || row.key} — ${row.key}`),
      more: Math.max(0, rows.length - shown.length),
      truncated: rows.length > shown.length,
      // GPT 裁定 Q4：候选按钮文案固定 `查看全部候选（{C}）` / `收起候选`。
      moreLabel: '查看全部候选（' + rows.length + '）',
      collapseLabel: '收起候选',
    };
  }

  /**
   * 历史候选预览（GPT 裁定 6）：**只展示、只读**，不发消息/不改名/不归档/不恢复会话；
   * 文案固定「历史候选（仅供参考）」，**不得**写"实际模型"。没有历史报告是正常态（新号）。
   */
  function automationHistoryPreview(source) {
    const data = source && typeof source === 'object' ? source : null;
    const rows = data && Array.isArray(data.candidates) ? data.candidates
      : (Array.isArray(data) ? data : []);
    const usable = rows.filter((row) => row && typeof row === 'object' && typeof row.key === 'string' && row.key);
    if (!usable.length) {
      return {
        title: '历史候选（仅供参考）', total: 0, lines: [], truncated: false,
        empty: '本次没有可用的历史报告（新号 /api/history/unified 为空时属正常）；历史处理不发消息、不改名、不归档。',
      };
    }
    const preview = automationCandidatesPreview({ complete: usable }, 5);
    return {
      title: '历史候选（仅供参考）', total: preview.total, lines: preview.lines,
      truncated: preview.truncated, more: preview.more, moreLabel: preview.moreLabel,
      collapseLabel: preview.collapseLabel, empty: null,
    };
  }

  /**
   * 折叠态的一行摘要（GPT 裁定 Q3 的模板，逐字）：`{状态短语}｜{模式与池摘要}｜余{M}`。
   *   · 例：`探测中｜筛选·Opus19｜余28` / `已保留｜参考·GPT7｜余28` / `暂停·人机验证｜筛选·Opus19`；
   *   · 只放三档信息：①当前动作或暂停原因 ②筛选开关+池简称+条数 ③剩余探针；
   *   · **不**放思考流状态 / 轮数 / 候选名（按 Q3 要求）。
   */
  function automationPanelSummaryLine() {
    automationEnsureState();
    const status = automationPanelStatusPhrase();
    const mode = automationSwitches().fixedFilter ? '筛选' : '参考';
    const pool = automationProbePoolInfo();
    const parts = [status, `${mode}·${automationPanelPoolShort()}`];
    if (pool) parts.push(`余${pool.remaining}`);
    return parts.join('｜');
  }

  /** 当前动作 / 暂停原因短语（折叠摘要第 ① 段；Q3：暂停原因用短语，展开后有完整说明）。 */
  function automationPanelStatusPhrase() {
    automationEnsureState();
    const phase = String(run.phase || 'IDLE');
    if (run.batchStopped === true) {
      const why = run.batchStopReason;
      if (why === 'PROBE_EXHAUSTED') return '已停止·探针池不可用';
      if (why === 'PROBE_LIMIT' || why === 'CHARGED_LIMIT') return '已停止·到自设上限';
      return '已停止';
    }
    const pauseMap = {
      HUMAN_VERIFICATION: '暂停·人机验证',
      ARCHIVE_UNVERIFIED: '暂停·归档失败',
      POOL_EMPTY: '暂停·配置无效',
      POOL_INVALID: '暂停·配置无效',
      SWITCH_CHANGED: '暂停·开关已改',
      THINKING_UNKNOWN: '暂停·思考流待定',
      THINKING_MISSING: '暂停·思考流不符',
      THINKING_PRESENT: '暂停·思考流不符',
      ROUND_SEND_FAILED: '暂停·发送失败',
      EVIDENCE_WRITE_FAILED: '暂停·留证失败',
      EVIDENCE_MISMATCH: '暂停·留证不一致',
    };
    if (phase === 'PAUSED') return pauseMap[run.reason] || ('暂停' + (run.reason ? '·' + run.reason : ''));
    if (phase === 'STOPPED') return run.reason === 'HUMAN_VERIFICATION' ? '已停止·人机验证' : '已停止';
    if (phase === 'ARCHIVING') return '归档中';
    if (phase === 'DONE') return '已保留';
    if (run.decision === 'KEEP') return '已保留';
    if (phase === 'PROBING' || phase === 'RUNNING') return '探测中';
    return '待开始';
  }

  /**
   * 名单摘要（折叠摘要第 ② 段）：本版恒定 = `目标{条数}`（如 `目标7`）。
   * 条数优先用 B′ 的生效名单（targetPoolEffectiveKeys），拿不到再退回本批锁定的名单快照。
   * ★ 旧版的 Opus19 / GPT7 / 全价67 / 自选{N} / 多选{N} 分支已随预设多选与行级勾选一起删除。
   */
  function automationPanelPoolShort() {
    let count = null;
    let targetId = null;
    try {
      if (typeof targetPoolEffectiveKeys === 'function') {
        const keys = targetPoolEffectiveKeys();
        if (Array.isArray(keys)) count = keys.length;
      }
    } catch (_) {}
    try {
      if (typeof targetPoolState === 'object' && targetPoolState && typeof targetPoolState.targetId === 'string') {
        targetId = targetPoolState.targetId;
      }
    } catch (_) {}
    if (count === null && run.batch && Array.isArray(run.batch.poolKeys)) count = run.batch.poolKeys.length;
    const label = (targetId && AUTOMATION_POOL_SHORT[targetId]) || AUTOMATION_POOL_SHORT[TARGET_ID_FALLBACK] || '目标';
    return label + (count === null ? '' : String(count));
  }

  /** 判定 / 命名 / 思考流 / 证据（面板第 ④ 块的短行数据）。 */
  function automationPanelVerdictLines() {
    automationEnsureState();
    const named = run.sessionName && run.sessionName.name ? run.sessionName.name : null;
    return {
      decision: run.decision
        ? `${run.decision}${run.policy && run.policy.reason ? '（' + run.policy.reason + '）' : ''}`
        : '—',
      name: named || (run.autoNameUnavailable ? '暂无法按价格命名' : '—'),
      thinking: run.thinking ? run.thinking.state : '—',
      evidence: run.evidenceFinal ? '已定稿' : '等待中',
    };
  }

  /**
   * 停止文案（卡 G；★ 0.6.3 改口径）：按**停止原因**给，不再有「本批 2 次探测均未命中…」这条专属规则。
   *   · PROBE_EXHAUSTED ⇒ 只表示**池不可用/为空**（0.6.3 起"一轮用尽"会自动轮换，不再停）
   *   · PROBE_LIMIT / CHARGED_LIMIT ⇒ 用户自设上限到线（写清上限值）
   *   · 其他 ⇒ 通用"已停止自动探测（原因）"
   */
  function automationBatchStopMessage(reason) {
    const why = reason && typeof reason === 'object' ? reason.reason : reason;
    if (why === 'PROBE_EXHAUSTED') return AUTOMATION_PROBE_EXHAUSTED_MESSAGE;
    if (why === 'CHARGED_LIMIT') {
      return `本批新增费用已累计 $${(Number(run.chargedUsd) || 0).toFixed(4)}，达到自设上限 $${automationLimitLabel(automationChargedLimitOf())}，已停止自动探测。`;
    }
    if (why === 'PROBE_LIMIT') {
      return `本批探针已达自设上限 ${automationLimitLabel(automationProbeLimitOf())} 条，已停止自动探测。`;
    }
    return `已停止自动探测（${why || 'UNKNOWN'}），报告已保存在本地。`;
  }

  // ── 状态机：约束 / 记账 / 停止线 ───────────────────────────────────────────

  function automationTrace(step) {
    if (!Array.isArray(run.trace)) run.trace = [];
    run.trace.push(step);
    if (run.trace.length > 16) run.trace.splice(0, run.trace.length - 16);
  }

  function automationSidTerminated(sid) {
    return (Array.isArray(run.archivedSids) && run.archivedSids.includes(sid))
      || (Array.isArray(run.terminatedSids) && run.terminatedSids.includes(sid));
  }

  function automationMarkTerminated(sid) {
    if (!Array.isArray(run.archivedSids)) run.archivedSids = [];
    if (!run.archivedSids.includes(sid)) run.archivedSids.push(sid);
    if (!Array.isArray(run.terminatedSids)) run.terminatedSids = [];
    if (!run.terminatedSids.includes(sid)) run.terminatedSids.push(sid);
  }

  /** 批是否可以继续：null 上限 = 不限（先判 null，绝不把 null 当 0）。 */
  function automationBatchCanContinue() {
    if (run.batchStopped === true) return false;
    const probesLimit = automationProbeLimitOf();
    const chargedLimit = automationChargedLimitOf();
    if (probesLimit !== null && (Number(run.probesUsed) || 0) >= probesLimit) return false;
    if (chargedLimit !== null && (Number(run.chargedUsd) || 0) >= chargedLimit) return false;
    return true;
  }

  /** charged 停止线（卡 G：null = 不限 ⇒ 永不因费用停）。 */
  function automationChargeBlock() {
    const chargedLimit = automationChargedLimitOf();
    if (chargedLimit === null) return null;
    return (Number(run.chargedUsd) || 0) >= chargedLimit ? 'CHARGED_LIMIT' : null;
  }

  /** 探针条数停止线（卡 G：null = 不限 ⇒ 永不因条数停；只有用户自设正数才到线）。 */
  function automationProbeLimitBlock() {
    const probesLimit = automationProbeLimitOf();
    if (probesLimit === null) return null;
    return (Number(run.probesUsed) || 0) >= probesLimit ? 'PROBE_LIMIT' : null;
  }

  function automationStopBatch(reason) {
    automationEnsureState();
    const why = reason || automationChargeBlock() || automationProbeLimitBlock() || 'BATCH_STOPPED';
    run.batchStopped = true;
    run.batchStopReason = why;                      // ★ 卡 G：停止必须记录原因
    run.batchStopMessage = automationBatchStopMessage(why);
    automationPause(why, run.batchStopMessage);
    return { stopped: why, message: run.batchStopMessage };
  }

  function automationStopLineSnapshot() {
    return {
      probesUsed: Number(run.probesUsed) || 0,
      probesLimit: automationProbeLimitOf(),
      chargedUsd: Number(run.chargedUsd) || 0,
      chargedLimitUsd: automationChargedLimitOf(),
      unlimited: automationProbeLimitOf() === null && automationChargedLimitOf() === null,
      missStreak: Number(run.missStreak) || 0,
      hitCount: Number(run.hitCount) || 0,
      batchStopped: run.batchStopped === true,
      batchStopReason: run.batchStopReason || null,
    };
  }

  function automationPause(reason, notice) {
    clearTimeout(probeTimer); probeTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(roundTimer); roundTimer = null;
    run.phase = 'PAUSED';
    run.reason = reason || 'PAUSED';
    run.pendingRound = 0;
    // Keep an unfinished round observable while paused; pending=false is not completion evidence.
    if (automationRoundJudgeable()) run.rounds.pending = false;
    if (notice) {
      run.notice = notice;
      automationNotify(notice);
    }
    automationPersist();
    save();
    return { phase: run.phase, reason: run.reason, notice: notice || null };
  }

  function automationPauseForPool(policy) {
    const reason = policy && policy.reason ? policy.reason : 'POOL_EMPTY';
    // ★ 名单固定 ⇒ 正常路径走不到这里（POOL_EMPTY / POOL_INVALID 只是防御分支：
    //   名单恒非空、且 7 条 key 都在内嵌目录有价表里）。真走到了就是配置被外部破坏 ⇒ 如实说"配置异常"。
    const notice = reason === 'POOL_INVALID'
      ? `已暂停自动探测：${AUTOMATION_POOL_PROMPT}（内嵌名单与运行目录不一致，配置异常）；未归档当前会话，也未创建新会话`
      : `已暂停自动探测：${AUTOMATION_POOL_PROMPT}（内嵌名单为空，配置异常）；未归档当前会话，也未创建新会话`;
    return automationPause(reason, notice);
  }

  /**
   * ★★ R1（用户 2026-10-11 权威口径，作废旧 NO_EVIDENCE→ARCHIVE）：
   * 确证终态仍取不到费用证据 ⇒ **暂停 + 停止自动推进**：不归档当前会话、不再排队新探针、
   * 不新建会话，交人工确认。理由（用户原话）：「一旦没有生成费用，就说明出现了 bug
   * （我们本来就是靠费用反推的）……那就可以停止了，再复生对话是没有用的」。
   * 「无证据」**不等于**「费用=0」，所以这里既不算命中也不算未命中。
   */
  function automationPauseNoEvidence(policy) {
    const detail = policy && typeof policy.message === 'string' && policy.message ? policy.message : '未取得有效费用证据';
    return automationPause('NO_EVIDENCE', `未取得费用证据（${detail}）：已暂停自动探测 —— `
      + '未归档当前会话、未排队新探针、未新建会话；「无证据」不等于「费用=0」，需人工确认。');
  }

  // ── 状态机：轮次 / thinking 观测 ───────────────────────────────────────────

  function automationRoundToken(kind, index) {
    return `${run.sessionId || 'no-sid'}#${kind}#${index}`;
  }

  function automationRoundPending() {
    return !!(run.rounds && typeof run.rounds === 'object' && run.rounds.pending === true);
  }

  /**
   * ★ 用户口径（2026-10-11）：「一般来说，得到了计费，那就可以直接判断了。」
   *
   *   ⇒ 本轮「可判定」= **拿到了本轮自己消息的完整计价**（billingReady）。
   *     Arena 的 turn-complete（outputComplete）只是加分证据，**不再是前置条件**。
   *     真机反例（会话 01a129a6）：完成信号与计价都已到达，完成态却被一条迟到的连接收尾抹掉，
   *     于是永久停在 WAIT_OUTPUT（该分支既无计时器也无出路），识别永不发生、模型名永远不出现。
   */
  function automationRoundJudgeable() {
    return !!(run.rounds && typeof run.rounds === 'object' && run.rounds.billingReady === true);
  }

  function automationBillRows(json) {
    const raw = json && json.messages;
    if (Array.isArray(raw)) return raw.map((row, i) => [String(row && (row.id || row.messageId) || '#' + i), row]);
    return raw && typeof raw === 'object' ? Object.entries(raw) : [];
  }

  function automationBeginRound(kind, index) {
    automationEnsureState();
    run.roundSequence = (Number(run.roundSequence) || 0) + 1;
    let baseline = null;
    try { baseline = JSON.parse(automationCachedCostText(run.sessionId)); } catch (_) {}
    run.rounds = {
      kind, index, pending: true, token: automationRoundToken(kind, index) + '#' + automationToken + '#' + run.roundSequence,
      afterSeq: run.streamWatermarks && run.streamWatermarks[run.sessionId],
      startedAt: Date.now(), outputComplete: false, billingReady: false, messageIds: [],
      baselineMessageIds: automationBillRows(baseline).map(([id]) => id), billingReads: 0,
    };
    run.thinking = { state: 'PENDING', round: index, kind, markers: [], complete: true, since: Date.now() };
    run.generateWaits = 0;
    run.refetchUsed = 0;
    run.evidenceFinal = false;
    run.pendingRound = kind === 'TASK' ? index : 0;
    automationPersist();
  }

  // Arena's output connection persists across turns and may replay old records.
  // A new message start binds its later packets to this exact run and round.
  function automationStreamRecord(sid, seq) {
    if (!sid || !Number.isFinite(Number(seq))) return;
    if (!run.streamWatermarks || typeof run.streamWatermarks !== 'object') run.streamWatermarks = {};
    run.streamWatermarks[sid] = Math.max(Number(run.streamWatermarks[sid]) || 0, Number(seq));
  }

  function automationStreamStart(sid, packet) {
    if (!activeAutomation(automationToken) || !automationRoundPending()) return null;
    if (!sid || (run.sessionId && sid !== run.sessionId) || (!run.sessionId && sid === run.previousSessionId)) return null;
    const round = run.rounds;
    const id = packet && packet.messageId;
    const seq = Number(packet && packet.seq);
    const oldIds = [...(round.baselineMessageIds || []), ...(run.settledMessageIds || [])];
    if (!id || oldIds.includes(String(id))) return null;
    // Sequence watermarks and known message IDs avoid assumptions about server/client clocks.
    if (round.afterSeq !== undefined && Number.isFinite(seq) && seq <= Number(round.afterSeq)) return null;
    if (round.outputComplete) return null;
    round.streamSid = sid;
    round.streamStarted = true;
    round.messageIds = [...new Set([...(round.messageIds || []), String(id)])];
    automationPersist();
    return { sid, automationToken, roundToken: round.token, messageIds: round.messageIds.slice() };
  }

  function automationStreamEvent(ctx) {
    const round = run.rounds;
    if (!ctx || ctx.automationToken !== automationToken || !round || ctx.roundToken !== round.token) return false;
    if (!ctx.sid || (run.sessionId && ctx.sid !== run.sessionId) || (round.streamSid && ctx.sid !== round.streamSid)) return false;
    if (ctx.kind === 'STREAM_END') {
      if (ctx.normalEnd === true && ctx.outputSeen === true) {
        round.outputComplete = true;
        round.outputEndedAt = Date.now();
        round.outputCostSerial = Number(run.costObservationSerial) || 0;
        round.messageIds = [...new Set([...(round.messageIds || []), ...(ctx.messageIds || []).map(String)])];
        automationSettleThinking('NORMAL_END');
      } else if (round.outputComplete !== true) {
        // ★ 迟到的中断信号（error/abort 包、缓冲溢出、连接被服务端收尾导致读流抛错）**不得撤销已成立的完成**。
        //   完成态由 Arena 自己的 turn-complete 控制记录确立（start → finish → turn-complete；见 20-network.js），
        //   之后的同轮 EOF/abort 只是连接收尾，不是「这轮没输出完」。
        //   真机反例（2026-10-11）：trace 里先 "@STREAM_END…wait:billing"（完成），紧接着一条中断把它抹回
        //   WAIT_OUTPUT —— WAIT_OUTPUT 没有计时器也没有出路，于是永久卡死、识别永不发生、拿不到模型名。
        round.outputComplete = false;
        automationMarkThinkingIncomplete(ctx.sid, 'STREAM_INTERRUPTED');
      }
      round.billingReady = false;
    }
    automationPersist();
    if (run.owned && run.sessionId === ctx.sid) {
      if (ctx.kind === 'STREAM_END' && round.outputComplete) {
        clearTimeout(costTimer); costTimer = null;
        automationScheduleCostRead(ctx.sid, 0);
      }
      void automationRun(Object.assign({}, ctx, { streamRecorded: true }));
    }
    return true;
  }

  function automationBillReady(evidence, ctx) {
    const round = run.rounds;
    if (!round) return false;
    if (round.billingReady === true && ctx.kind !== 'COST' && ctx.kind !== 'COST_READ') return true;
    if (ctx.kind !== 'COST' && ctx.kind !== 'COST_READ') return false;
    const rows = automationBillRows(evidence.json);
    const ids = round.messageIds || [];
    // 归属：账单行必须属于**本轮自己的消息**（轮次开始时已记账的旧消息不算 ⇒ 见 baselineMessageIds）。
    if (!ids.length) return false;
    const complete = (row) => {
      if (!row || typeof row !== 'object') return false;
      const actual = row.actual || row.costDetail || row.cost;
      if (!actual || typeof actual !== 'object') return false;
      return ['inputTokensCostUsd', 'cacheWriteTokensCostUsd', 'cacheReadTokensCostUsd', 'outputTokensCostUsd']
        .every((key) => actual[key] !== null && actual[key] !== undefined && actual[key] !== ''
          && Number.isFinite(Number(actual[key])) && Number(actual[key]) >= 0)
        && row.basePriceUsd !== null && row.basePriceUsd !== undefined && row.basePriceUsd !== ''
        && Number.isFinite(Number(row.basePriceUsd)) && Number(row.basePriceUsd) >= 0
        // Visible output from these priced candidates must have an observed output charge.
        // Zero is a legitimate cache/input value, but an output-zero placeholder is not final billing.
        && Number(actual.outputTokensCostUsd) > 0
        && row.totalChargedUsd !== null && row.totalChargedUsd !== undefined && row.totalChargedUsd !== ''
        && Number.isFinite(Number(row.totalChargedUsd)) && Number(row.totalChargedUsd) >= 0;
    };
    // ★ 用户口径（2026-10-11）：「一般来说，得到了计费，那就可以直接判断了。」
    //   ⇒ 本轮自己消息的**完整计价**本身就是可判定证据，**不再要求先观测到 turn-complete**。
    //     不完整/占位的账单（缺字段、输出价为 0、无 totalChargedUsd）仍一律不算数 —— 这是原有的完整计价判据。
    if (!ids.every((id) => rows.some(([rowId, row]) => rowId === id && complete(row)))) return false;
    // 反旧读数：读盘点必须晚于本轮开始；观测到输出结束时用更严格的 outputEndedAt。
    const freshAfter = Number(round.outputEndedAt) || Number(round.startedAt) || 0;
    if (ctx.costRequestedAt && freshAfter && Number(ctx.costRequestedAt) < freshAfter) return false;
    if (round.outputComplete === true && round.outputEndedAt
      && (Number(run.costObservationSerial) || 0) <= (Number(round.outputCostSerial) || 0)) return false;
    round.billingReady = true;
    round.billedAt = Date.now();
    return true;
  }

  function automationWaitForRound(sid, reason) {
    run.decision = 'WAIT';
    run.reason = reason;
    run.policy = { decision: 'WAIT', reason, matchedKeys: [], completeCount: 0 };
    run.notice = reason === 'WAIT_OUTPUT'
      ? '等待本轮消息的完整计价；有思考会立即排除，计价一到就识别模型。'
      : '等待本轮消息的完整计价；暂不判定模型。';
    automationTrace(reason === 'WAIT_OUTPUT' ? 'wait:output' : 'wait:billing');
    // Read retries never become completion evidence. Continue polling the same
    // session at a bounded rate so delayed billing can finish without user action.
    // ★ 只对 WAIT_BILLING 排读：费用面板自己每 15s 读一次价（50-cost.js startCostReadout），
    //   那次读数会走 onCost ⇒ 同一条判定链 ⇒ 「得到计费就判」不需要在这里额外轮询；
    //   在 WAIT_OUTPUT 也排读会变成 ~2s 一轮的请求（真机已观察到 /cost 429 限流），得不偿失。
    if (reason === 'WAIT_BILLING' && run.rounds) {
      run.rounds.billingReads = (Number(run.rounds.billingReads) || 0) + 1;
      automationScheduleCostRead(sid, Math.max(automationTiming.costGapMs, 2000));
    }
    automationPersist();
    save();
  }

  function automationRecordThoughtMarkers(markers, source) {
    const list = (Array.isArray(markers) ? markers : []).filter((item) => typeof item === 'string' && item);
    if (!list.length) return;
    automationEnsureState();
    const thinking = run.thinking;
    thinking.markers = [...new Set([...(thinking.markers || []), ...list])];
    thinking.state = 'SEEN';
    // ★ R2：如实记录命中来源（'dom' = 页面上真正渲染出来的 thinking 标签，本版唯一通道）。
    if (typeof source === 'string' && source) thinking.source = source;
    thinking.seenAt = Date.now();
    thinking.lastEventAt = Date.now();
    automationPersist();
  }

  /**
   * ★★ DOM 判据（用户 2026-10-11 权威口径，取代流量判据）
   *
   *   用户原话：「我能看到的，是浏览器页面上面的……如果抽到了模型，而且它有思考，
   *             就会真正显示出 Thinking 这个词。应该检查的是这个，而不是它的流量。」
   *            「思考完了会有 thought for n second；思考时会是 thinking，
   *              在出现 thinking 的时候就可以截断。」
   *
   * ⇒ 判据 = **页面上真正渲染出来的** thinking 标签（思考卡片按钮上的那行字）。
   *   流量里的 reasoning/thinking/thought 事件**不再作为判据**（20-network.js 已撤掉该分支）。
   *   真机反例（本机 2026-10-11 实测）：同一条 assistant 消息里 **7 个 reasoning 部件 text 全为空**、
   *   页面上不显示任何思考，SSE 却照发 reasoning-start ⇒ 按流量判会把这轮误归档；
   *   而且当时会顺手掐断流读取，永远等不到 turn-complete（会话卡在「等待输出完成」，拿不到计价与模型名）。
   */
  const AUTOMATION_DOM_THINKING_RE = /^thinking\b/i;

  /** 读页面上思考卡片的标签：命中 = 正在思考；null = 页面上没有正在进行的思考。 */
  function automationDomThinkingLabel() {
    let nodes;
    try { nodes = document.querySelectorAll('[data-agent-transcript-message] button'); }
    catch (_) { return null; }
    for (const node of nodes) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 40 && AUTOMATION_DOM_THINKING_RE.test(text)) return text;
    }
    return null;
  }

  let domThinkingObserver = null;
  let domThinkingSweepAt = 0;
  let domThinkingHits = 0;

  /** 只有「本会话 + 本轮 + 还没判过」才把页面命中的 thinking 交给同一条决策链（onThought）。 */
  function automationSweepDomThinking() {
    const now = Date.now();
    if (now < domThinkingSweepAt) return;                 // 转录区每帧都在变，扫得太勤没必要
    domThinkingSweepAt = now + 100;
    if (!activeAutomation(automationToken)) return;
    if (run.owned !== true || !['PROBING', 'RUNNING'].includes(run.phase)) return;
    const sid = run.sessionId;
    if (!sid || currentSessionId() !== sid) return;        // 页面必须停在本轮会话上，否则是旧转录
    if (!run.rounds || run.rounds.pending !== true) return;
    if (run.thinking && run.thinking.state === 'SEEN') return;
    const label = automationDomThinkingLabel();
    if (!label) return;
    domThinkingHits += 1;
    automationTrace('dom:thinking');
    onThought(sid, ['dom:' + label], 'dom');
  }

  /** 装一次页面观察器（脚本在 /agent 页启动时装；60-bootstrap.js 调用）。 */
  function automationWatchDomThinking() {
    if (domThinkingObserver || typeof MutationObserver !== 'function' || !document.documentElement) return;
    domThinkingObserver = new MutationObserver(() => {
      try { automationSweepDomThinking(); } catch (_) {}
    });
    domThinkingObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    automationSweepDomThinking();
  }

  /** 结算观测：正常结束且观测完整 ⇒ NOT_SEEN；否则 UNKNOWN（**不猜**）。 */
  function automationSettleThinking(reason) {
    automationEnsureState();
    const thinking = run.thinking;
    if (thinking.state === 'SEEN') { thinking.settleReason = reason; return thinking; }
    if (thinking.state !== 'PENDING') return thinking;
    thinking.state = (reason === 'NORMAL_END' && thinking.complete === true) ? 'NOT_SEEN' : 'UNKNOWN';
    thinking.settleReason = reason;
    thinking.settledAt = Date.now();
    automationPersist();
    return thinking;
  }

  /** 外部信号：观测被中断/漏事件 ⇒ 观测不完整（「要」时据此暂停并保留，绝不当成"没有"）。 */
  function automationMarkThinkingIncomplete(sid, reason) {
    automationEnsureState();
    if (sid && run.sessionId && sid !== run.sessionId) return false;
    const thinking = run.thinking;
    thinking.complete = false;
    thinking.incompleteReason = reason ? String(reason) : 'EXTERNAL_SIGNAL';
    if (thinking.state === 'PENDING') thinking.state = 'UNKNOWN';
    automationPersist();
    save();
    return true;
  }

  // ── 状态机：主流水线（约束 → 池判定 → thinking → 决定） ────────────────────

  async function automationRun(ctx) {
    try { await automationRunInner(ctx && typeof ctx === 'object' ? ctx : {}); }
    catch (error) {
      run.notice = `自动化内部错误：${String((error && error.message) || error)}`;
      automationPersist();
    }
  }

  async function automationCollectEvidence(sid, ctx) {
    const out = { text: null, json: null, report: null, status: null, fetched: false, error: null };
    if (ctx.fetch === true) {
      try {
        const result = await automationFetchCostOnce(sid);
        out.fetched = true;
        out.status = result && result.status !== undefined ? result.status : null;
        if (result && typeof result.text === 'string') out.text = result.text;
        if (result && result.ok === false) out.error = `HTTP ${out.status}`;
      } catch (error) {
        out.error = String((error && error.message) || error);
      }
      if (typeof out.text === 'string' && out.text) {
        try { setIdentifySource(sid, out.text); } catch (_) {}
      }
    } else {
      out.text = automationCachedCostText(sid);
    }
    if (typeof out.text === 'string' && out.text) {
      try { out.json = JSON.parse(out.text); } catch (_) { out.json = null; out.error = out.error || 'NOT_JSON'; }
    }
    if (out.json) {
      try { out.report = automationIdentifyReport(out.json); }
      catch (error) { out.report = null; out.error = `IDENTIFY_ERROR:${String((error && error.message) || error)}`; }
    }
    return out;
  }

  function automationCachedCostText(sid) {
    try {
      const view = identifyView;
      const source = view && view.source ? view.source : null;
      if (source && source.sid === sid && typeof source.text === 'string' && source.text) return source.text;
    } catch (_) {}
    return null;
  }

  function automationRecordCost(sid, evidence, status) {
    if (!evidence || typeof evidence !== 'object') return null;
    automationEnsureState();
    const total = automationNumber(evidence.total, null);
    const bySid = run.chargedBySid;
    const previous = automationNumber(bySid[sid], 0) || 0;
    if (total !== null) {
      const delta = total - previous;
      if (delta > 0) run.chargedUsd = (Number(run.chargedUsd) || 0) + delta;
      bySid[sid] = Math.max(previous, total);
    }
    run.lastCost = {
      basePriceUsd: evidence.base, inputTokensCostUsd: evidence.in,
      cacheWriteTokensCostUsd: evidence.cw, cacheReadTokensCostUsd: evidence.cr,
      outputTokensCostUsd: evidence.out, totalChargedUsd: evidence.total,
      status: status === undefined ? null : status, at: Date.now(),
    };
    return { total, chargedUsd: Number(run.chargedUsd) || 0 };
  }

  /** Only a matching terminal output event plus fresh, complete current-message billing can settle. */
  function automationShouldSettleRound(ctx) {
    return (ctx.kind === 'COST' || ctx.kind === 'COST_READ') && automationRoundPending()
      && automationRoundJudgeable();
  }

  async function automationRunInner(ctx) {
    const sid = ctx.sid;
    const eventToken = automationToken;
    const eventRoundToken = run.rounds && run.rounds.token;
    automationEnsureState();
    if (ctx.automationToken !== undefined && ctx.automationToken !== eventToken) return;
    if (ctx.roundToken && ctx.roundToken !== eventRoundToken) return;
    if (ctx.kind === 'STREAM_END' && !ctx.streamRecorded) {
      if (ctx.normalEnd !== true || ctx.outputSeen !== true) {
        // 同 1300 行的守卫：已完成的轮次不被迟到的中断撤销。
        if (run.rounds.outputComplete !== true) automationMarkThinkingIncomplete(sid, 'STREAM_INTERRUPTED');
        return;
      }
      if (sid !== run.sessionId || run.owned !== true) return;
      run.rounds.outputComplete = true;
      run.rounds.outputEndedAt = Date.now();
      run.rounds.outputCostSerial = Number(run.costObservationSerial) || 0;
      run.rounds.messageIds = [...new Set([...(run.rounds.messageIds || []), ...(ctx.messageIds || []).map(String)])];
      automationSettleThinking('NORMAL_END');
    }
    automationTrace(`@${ctx.trigger || ctx.kind || 'EVENT'}`);
    automationTrace('constraints');
    if (!activeAutomation(automationToken)) { automationTrace('abort:inactive'); return; }
    if (!sid || typeof sid !== 'string') return;
    if (sid !== run.sessionId || run.owned !== true) { automationTrace('ignore:not-owned'); return; }
    if (automationSidTerminated(sid)) { automationTrace('ignore:terminated'); return; }
    if (run.phase === 'ARCHIVING') { automationTrace('ignore:archiving'); return; }
    if (run.phase === 'PAUSED' && ctx.allowPaused !== true) { automationTrace('ignore:paused'); return; }
    if (automationHumanVerificationVisible()) { stopForHumanVerification(); return; }

    // ⓪ 用户改控件 ⇒ 被动发现（B′ 的控件层只改状态 + 落本地记忆，effects 恒为空，不回调本卡）。
    //    开关变化：只「暂停后续自动发送 + 重判已有证据」，**不归档、不发消息**；恢复后按新规则执行（清单 30）。
    if (ctx.allowPaused !== true && automationSwitchesChanged()) {
      automationTrace('switches:changed');
      await automationApplySwitchChange();
      return;
    }
    //    池变化：就地重判本地 report + 取消尚未发送的任务；不自动恢复、不自动续发、不重置预算（清单 8/20）。
    if (ctx.allowPaused !== true && run.batch && Array.isArray(run.batch.poolKeys) && automationPoolChanged()) {
      automationTrace('pool:changed');
      await automationApplyPoolChange();
      return;
    }

    // ① 费用记账（先取原文：COST_READ 自己读一次；COST 用页面自己刚抓到的那份）
    let charge = ctx.evidence && typeof ctx.evidence === 'object' ? ctx.evidence : null;
    let status = ctx.status === undefined ? null : ctx.status;
    let collected = null;
    if (ctx.kind === 'COST_READ') {
      ctx.costRequestedAt = Date.now();
      collected = await automationCollectEvidence(sid, { fetch: true });
      if (collected.json) {
        try { charge = extractCost(collected.text) || charge; } catch (_) {}
      }
      status = collected.status;
      if (eventToken !== automationToken || !activeAutomation(eventToken)) return;
      if (eventRoundToken !== (run.rounds && run.rounds.token)) { automationTrace('ignore:round-changed'); return; }
      if (sid !== run.sessionId || run.owned !== true) { automationTrace('ignore:session-changed'); return; }
    }
    if (ctx.kind === 'COST' || ctx.kind === 'COST_READ') {
      run.costObservationSerial = (Number(run.costObservationSerial) || 0) + 1;
      automationRecordCost(sid, charge, status);
    }
    if (ctx.kind === 'THOUGHT') automationRecordThoughtMarkers(ctx.markers, ctx.source);

    // ② 池判定（纯函数；门禁只在开关一开启时生效，关闭时同一结果只作参考）
    const switches = automationSwitches();
    run.switches = switches;
    const evidence = collected || await automationCollectEvidence(sid, { fetch: false });
    if (eventToken !== automationToken || eventRoundToken !== (run.rounds && run.rounds.token)
      || sid !== run.sessionId || run.owned !== true || automationSidTerminated(sid) || run.phase === 'ARCHIVING'
      || (run.phase === 'PAUSED' && ctx.allowPaused !== true)) return;
    // Positive thinking evidence is the only immediate exclusion. Every price
    // decision, name change and subsequent task must pass the same completion gate.
    if (run.thinking.state === 'SEEN') {
      const thinking = automationThinkingDecision({ fixedFilter: switches.fixedFilter, thinkingMode: switches.thinkingMode, thinking: run.thinking });
      run.thinkingDecision = { action: thinking.action, reason: thinking.reason, state: thinking.state,
        markers: automationThinkingHitDetail(run.thinking).markers, source: automationThinkingHitDetail(run.thinking).source };
      if (thinking.stopGeneration) automationStopGeneration();
      if (thinking.action === 'archive') {
        automationTrace('decide:archive');
        await automationArchiveSession(sid, { sid, trigger: ctx.trigger || ctx.kind,
          report: evidence.report, evidence, switches, policy: null, reason: thinking.reason, thinking: thinking.state });
        return;
      }
    }
    if (!run.rounds) { automationWaitForRound(sid, 'WAIT_OUTPUT'); return; }
    // ★ 用户口径（2026-10-11）：「一般来说，得到了计费，那就可以直接判断了。」
    //   ⇒ 计价齐了就判；拿不到完整计价才等（「等输出完成」只是其中一种情形，不再是唯一前置）。
    if (!automationBillReady(evidence, ctx)) {
      automationWaitForRound(sid, run.rounds.outputComplete === true ? 'WAIT_BILLING' : 'WAIT_OUTPUT');
      return;
    }
    const policy = automationPolicy(evidence.report, {});
    const gateOn = switches.fixedFilter === true;
    automationTrace(gateOn ? 'pool:gate' : 'pool:advisory');
    const ctxForAction = {
      sid, trigger: ctx.trigger || ctx.kind, policy,
      report: evidence.report, evidence, switches,
    };

    let waiting = false;
    let paused = false;
    if (gateOn) {
      if (policy.decision === 'PAUSE') {
        // ★★ R2 优先（用户 2026-10-11）：思考流命中是**正面观测**，它的恒定规则（立刻中断 + 归档）
        //   不该被「无费用证据」的暂停盖住 —— 否则「思考中的会话要被归档」在恰好同时缺费用时失效。
        //   只在 PAUSE 分支做这一步 ⇒ KEEP / ARCHIVE / WAIT 三条现有路径的顺序与 trace 一字不动。
        const earlyThinking = automationThinkingDecision({
          fixedFilter: gateOn,
          thinkingMode: switches.thinkingMode,
          thinking: run.thinking,
        });
        if (earlyThinking.action === 'archive') {
          run.thinkingDecision = {
            action: earlyThinking.action, reason: earlyThinking.reason, state: earlyThinking.state,
            markers: automationThinkingHitDetail(run.thinking).markers,
            source: automationThinkingHitDetail(run.thinking).source,
          };
          if (earlyThinking.stopGeneration) automationStopGeneration();
          automationTrace('decide:archive');
          await automationArchiveSession(sid, Object.assign({}, ctxForAction, {
            reason: earlyThinking.reason, thinking: earlyThinking.state,
          }));
          return;
        }
        automationTrace('decide:pause');
        // ★ R1：NO_EVIDENCE（无费用证据）与 POOL_INVALID/POOL_EMPTY（配置异常）文案分开，别混说。
        if (policy.reason === 'NO_EVIDENCE') automationPauseNoEvidence(policy);
        else automationPauseForPool(policy);
        return;
      }
      if (policy.decision === 'WAIT') {
        waiting = true;
      } else if (policy.decision === 'ARCHIVE') {
        automationTrace('decide:archive');
        await automationArchiveSession(sid, Object.assign({}, ctxForAction, { reason: policy.reason }));
        return;
      }
    } else {
      // 开关一关闭（默认）：POOL_MISS / NO_COMPLETE / NO_EVIDENCE 只作参考，绝不自动归档；
      // 池为空/无效也不阻止普通使用。仍然只读重取，为了拿到可命名的 report。
      if (policy.decision === 'WAIT') waiting = true;
    }

    if (waiting) {
      if (ctx.kind === 'COST' || ctx.kind === 'COST_READ' || ctx.kind === 'COST_EXHAUSTED' || ctx.kind === 'RESUME') {
        const advanced = await automationRefetchOrFinalize(sid, policy, ctxForAction, {
          advisory: !gateOn,
          forceFinal: ctx.kind === 'COST_EXHAUSTED',
        });
        if (advanced === 'ARCHIVED') return;
        if (advanced === 'PAUSED') paused = true;
      } else {
        automationTrace('wait:no-refetch-on-thought');
      }
    }

    // ③ thinking 要求（只对可保留的会话）
    automationTrace('thinking');
    const settled = automationShouldSettleRound(ctx);
    if (settled) automationSettleThinking(evidence.report ? 'NORMAL_END' : 'NO_EVIDENCE');
    // 费用读不出来 ⇒ 没能证明本轮结束 ⇒ 观测按 UNKNOWN 结算（绝不当作「没有」）
    if (ctx.kind === 'COST_EXHAUSTED') automationSettleThinking('NO_EVIDENCE');
    const thinking = automationThinkingDecision({
      fixedFilter: gateOn,
      thinkingMode: switches.thinkingMode,
      thinking: run.thinking,
    });
    run.thinkingDecision = {
      action: thinking.action, reason: thinking.reason, state: thinking.state,
      // ★ R2：命中原文 + 来源随判定一起留证（可只读复核"为什么归档"）。
      markers: automationThinkingHitDetail(run.thinking).markers,
      source: automationThinkingHitDetail(run.thinking).source,
    };
    if (thinking.stopGeneration) automationStopGeneration();
    if (thinking.action === 'archive' && !paused) {
      automationTrace('decide:archive');
      await automationArchiveSession(sid, Object.assign({}, ctxForAction, { reason: thinking.reason, thinking: thinking.state }));
      return;
    }
    if (thinking.action === 'pause' && !paused) {
      automationTrace('decide:pause');
      automationPause(thinking.reason, thinking.notice);
      return;
    }
    if (paused) return;
    if (waiting) { automationTrace('wait:hold'); return; }

    // ④ 决定：继续
    automationTrace('decide:keep');
    await automationKeepSession(sid, ctxForAction, settled);
  }

  /** WAIT 分支：只读重取 ≤2；耗尽后置 evidenceFinal=true 并按 A′ 的最终判定处理。 */
  async function automationRefetchOrFinalize(sid, policy, ctxForAction, opts) {
    const advisory = !!(opts && opts.advisory);
    const forceFinal = !!(opts && opts.forceFinal) || run.evidenceFinal === true;
    const used = Number(run.refetchUsed) || 0;
    if (!forceFinal && used < AUTOMATION_REFETCH_MAX) {
      run.refetchUsed = used + 1;
      automationPersist();
      automationTrace(`wait:refetch#${run.refetchUsed}`);
      automationScheduleCostRead(sid, automationTiming.costGapMs);
      return 'WAITING';
    }
    run.evidenceFinal = true;
    automationPersist();
    automationTrace('wait:exhausted');
    if (advisory) {
      // 开关一关闭：不归档，保留会话，只暂停后续自动发送（面板显示"暂无法按价格命名"）。
      run.autoNameUnavailable = true;
      automationTrace('decide:pause');
      automationPause('NO_EVIDENCE_REFERENCE_ONLY',
        '未取得有效费用证据；固定筛选关闭，池判定只作参考：已暂停后续自动发送，未归档当前会话（暂无法按价格命名）');
      return 'PAUSED';
    }
    // 用 evidenceFinal=true 重新要一次最终判定。
    // ★★ R1（用户 2026-10-11，作废旧「强制 ARCHIVE」兜底）：无费用证据 ⇒ 判定器回
    //   PAUSE/NO_EVIDENCE（**不再**是 ARCHIVE）⇒ 这里只暂停 + 停止自动推进：
    //   不归档当前会话、不再排队新探针、不新建会话。**判定器若仍回 WAIT 也一律暂停**，
    //   绝不再把它改写成 ARCHIVE/NO_EVIDENCE 去归档（旧实现正是这么"提前归档"的）。
    const finalPolicy = automationPolicy(ctxForAction.report, { evidenceFinal: true });
    run.decision = finalPolicy.decision;
    run.policy = finalPolicy;
    if (finalPolicy.decision === 'ARCHIVE') {
      await automationArchiveSession(sid, Object.assign({}, ctxForAction, {
        reason: finalPolicy.reason, policy: finalPolicy,
      }));
      return 'ARCHIVED';
    }
    automationTrace('decide:pause');
    automationPauseNoEvidence(finalPolicy);
    return 'PAUSED';
  }

  // ── 状态机：动作 ───────────────────────────────────────────────────────────

  function automationAutoSendBlock() {
    // ★ 卡 G：探针条数上限只限制「开新探针」（queueNextProbe 里判 canContinue），
    //   **不**限制当前会话内的任务轮次 —— 否则 probeLimit=1 会把 rounds 一起砍掉（T3 的语义）。
    const block = automationChargeBlock();
    if (block) return block;                        // 用户自设 charged 上限到线 ⇒ 立刻停（探针与任务都不再发）
    if (run.batchStopped === true) return run.batchStopReason || 'BATCH_STOPPED';
    return null;
  }

  /** ④ 继续：命名 + 按 rounds 发任务（rounds=0 不发；重复回调不重复推进/改名）。 */
  async function automationKeepSession(sid, ctxForAction, settled) {
    run.notice = null;   // 先清旧提示，别把下面命名失败的提示冲掉
    // ★ 卡 G：命中 ⇒ 连续未命中计数归零；命中次数按**会话**去重计数（同一会话重复回调不重复计）。
    const matched = ctxForAction && ctxForAction.policy && Array.isArray(ctxForAction.policy.matchedKeys)
      ? ctxForAction.policy.matchedKeys : [];
    if (matched.length > 0) {
      run.missStreak = 0;
      automationEnsureState();
      if (sid && !run.hitSids.includes(sid)) {
        run.hitSids.push(sid);
        run.hitCount = run.hitSids.length;
      }
    }
    const keepToken = automationToken;
    const keepRound = run.rounds && run.rounds.token;
    const naming = await automationApplyNaming(sid, ctxForAction, 'KEEP');
    if (keepToken !== automationToken || keepRound !== (run.rounds && run.rounds.token)
      || sid !== run.sessionId || !run.owned || !['RUNNING', 'PROBING'].includes(run.phase)) return { advanced: false, naming };
    if (!settled) { automationTrace('keep:no-round-advance'); return { advanced: false, naming }; }
    const block = automationAutoSendBlock();
    if (block) { automationStopBatch(block); return { advanced: false, naming, stopped: block }; }
    const token = automationRoundPending() ? run.rounds.token : null;
    if (token === null) { automationTrace('keep:round-already-settled'); return { advanced: false, naming }; }
    if (run.rounds) {
      run.rounds.pending = false;
      run.settledMessageIds = [...new Set([...(run.settledMessageIds || []), ...(run.rounds.messageIds || [])])];
    }
    const total = Math.max(0, Math.floor(automationNumber(config.rounds, 0) || 0));
    run.phase = 'RUNNING';
    run.reason = null;
    if (total <= 0) {
      run.phase = 'DONE';
      run.reason = 'ROUNDS_ZERO';
      run.pendingRound = 0;
      automationPersist();
      save();
      automationTrace('keep:rounds-zero');
      return { advanced: false, naming, phase: 'DONE' };
    }
    const round = run.rounds && run.rounds.kind === 'TASK' ? run.rounds.index : 0;
    if (round <= 0) {
      automationPersist();
      save();
      scheduleRound(1);
      return { advanced: true, naming, round: 1 };
    }
    run.completedRounds = round;
    if (round >= total) {
      run.phase = 'DONE';
      run.reason = 'ROUNDS_DONE';
      run.pendingRound = 0;
      automationPersist();
      save();
      return { advanced: false, naming, phase: 'DONE' };
    }
    automationPersist();
    save();
    scheduleRound(round + 1);
    return { advanced: true, naming, round: round + 1 };
  }

  /**
   * ARCHIVE 全流程：留证（先）→ 改名 + 归档 + 复核（E archiveAndVerify）→
   * 只有确认成功才允许创建下一个会话；失败一律暂停（不重试、不新建）。
   */
  async function automationArchiveSession(sid, ctxForAction) {
    const token = automationToken;
    if (!activeAutomation(token)) return { archived: false, stopped: 'INACTIVE' };
    if (automationSidTerminated(sid)) return { archived: false, stopped: 'TERMINATED' };
    if (sid !== run.sessionId || run.owned !== true) return { archived: false, stopped: 'NOT_OWNED' };
    if (run.phase === 'ARCHIVING') return { archived: false, stopped: 'ALREADY_ARCHIVING' };
    const context = ctxForAction && typeof ctxForAction === 'object' ? ctxForAction : {};
    const switches = automationSwitches();
    const candidates = automationNameCandidates(context.report, {
      fixedFilter: switches.fixedFilter,
      matchedKeys: context.policy && context.policy.matchedKeys,
    });
    const outcome = automationNameOutcome(context.reason);
    const name = automationNameFor(outcome, candidates) || `${AUTOMATION_NAME_PREFIX.POOL_MISS}${context.reason}`;

    clearTimeout(roundTimer); roundTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(probeTimer); probeTimer = null;
    run.phase = 'ARCHIVING';
    run.decision = 'ARCHIVE';
    run.reason = context.reason || 'ARCHIVE';
    run.archiveName = name;
    run.autoNameUnavailable = false;
    run.sessionName = {
      key: `${outcome}|${name}|${candidates.map((item) => item.key).join(',')}`,
      name, at: Date.now(), ok: null, via: 'archive',
    };
    if (run.rounds) run.rounds.pending = false;
    if (run.thinking && run.thinking.state === 'PENDING') {
      run.thinking = Object.assign({}, run.thinking, { state: 'UNKNOWN', settleReason: 'ARCHIVED' });
    }
    automationPersist();
    save();

    // ① 先写本地留证（清单 16）：写成功才允许归档；写失败 ⇒ 暂停
    const record = automationBuildEvidenceRecord(sid, context, name, candidates);
    const written = automationWriteEvidence(record);
    run.lastEvidence = { ok: written.ok === true, error: written.error || null, id: record.id, at: record.at };
    run.notice = written.ok === true ? `已留证 ${record.id}（本地）` : `本地留证失败：${written.error || '未知'}`;
    automationPersist();
    save();
    if (written.ok !== true) {
      automationTrace('archive:evidence-write-failed');
      automationPause('EVIDENCE_WRITE_FAILED',
        `本地留证写入失败（${written.error || '未知'}）；已暂停：不归档、不新建会话`);
      return { archived: false, stopped: 'EVIDENCE_WRITE_FAILED' };
    }

    // ② 改名 + 归档 + 复核（E 的闭环）
    automationTrace(`archive:${context.reason || 'ARCHIVE'}`);
    let result = null;
    try { result = await automationArchiveAndVerify(sid, { name }); }
    catch (error) { result = { ok: false, via: 'none', evidence: `THROWN:${String((error && error.message) || error)}` }; }
    const confirmed = automationArchiveConfirmed(result);
    run.lastArchive = {
      ok: confirmed,
      via: result && result.via ? result.via : 'none',
      evidence: result && result.evidence ? String(result.evidence).slice(0, 800) : null,
      at: Date.now(),
    };
    automationPersist();
    save();
    if (!confirmed) {
      automationTrace('archive:unverified');
      automationPause('ARCHIVE_UNVERIFIED',
        `归档未确认（via=${run.lastArchive.via}）；已暂停：不重试、不新建会话`);
      return { archived: false, stopped: 'ARCHIVE_UNVERIFIED' };
    }

    // ③ 确认成功 ⇒ 记终止、清场；只有这时才允许开下一个会话
    automationMarkTerminated(sid);
    if (run.sessionName) run.sessionName.ok = true;
    run.owned = false;
    run.sessionId = null;
    run.pendingRound = 0;
    run.rounds = null;
    run.refetchUsed = 0;
    run.evidenceFinal = false;
    // ★ 卡 G：未命中（POOL_MISS / NO_COMPLETE / NO_EVIDENCE）连续计数；每 10 次只更新提示，
    //   **绝不**因为计数而暂停 —— 归档确认成功后照常自动继续下一条。
    const missLike = /^(POOL_MISS|NO_COMPLETE|NO_EVIDENCE)/.test(String(context.reason || ''));
    if (missLike) {
      run.missStreak = (Number(run.missStreak) || 0) + 1;
      if (run.missStreak % AUTOMATION_MISS_NOTICE_EVERY === 0) {
        run.notice = `会话已归档：${name}；连续未命中 ${run.missStreak} 次，继续探测中`;
      } else {
        run.notice = `会话已归档：${name}`;
      }
    } else {
      run.notice = `会话已归档：${name}`;
    }
    automationPersist();
    save();
    automationNotify(`已归档：${name}`);
    if (!automationBatchCanContinue()) {
      automationStopBatch();
      return { archived: true, stopped: run.reason, missStreak: Number(run.missStreak) || 0 };
    }
    // 归档**确认成功** ⇒ 自动继续下一条（不再等用户确认）；命中路径不会走到这里。
    automationTrace('archive:confirmed-continue');
    queueNextProbe(context.reason || 'ARCHIVE', token);
    return { archived: true, stopped: null, missStreak: Number(run.missStreak) || 0 };
  }

  function automationArchiveConfirmed(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.ok === true) return true;
    return typeof result.evidence === 'string' && result.evidence.startsWith('ALREADY_ARCHIVED');
  }

  /** 命名（清单 21–24）：幂等（同一 report 重复回调不反复改名）、只改 owned、失败只提示。 */
  async function automationApplyNaming(sid, ctxForAction, outcome) {
    if (sid !== run.sessionId || run.owned !== true) return { applied: false, skipped: 'NOT_OWNED' };
    const switches = automationSwitches();
    const candidates = automationNameCandidates(ctxForAction && ctxForAction.report, {
      fixedFilter: switches.fixedFilter,
      matchedKeys: ctxForAction && ctxForAction.policy ? ctxForAction.policy.matchedKeys : null,
    });
    const name = automationNameFor(outcome, candidates);
    if (!name) {
      run.autoNameUnavailable = true;
      run.sessionName = run.sessionName || null;
      automationPersist();
      return { applied: false, skipped: 'NO_CANDIDATES' };
    }
    run.autoNameUnavailable = false;
    const key = `${outcome}|${name}|${candidates.map((item) => item.key).join(',')}`;
    if (run.sessionName && run.sessionName.key === key) {
      return { applied: false, skipped: 'IDEMPOTENT', name };
    }
    const namingToken = automationToken;
    const namingRound = run.rounds && run.rounds.token;
    // Reserve this key before awaiting the UI/API rename to prevent duplicate writes.
    run.sessionName = { key, name, at: Date.now(), ok: null, pending: true };
    let ok = null;
    try { ok = await automationRename(name); }
    catch (error) { ok = false; run.notice = `改名失败（${String((error && error.message) || error)}），只提示，不影响保留/归档决策`; }
    if (namingToken !== automationToken || namingRound !== (run.rounds && run.rounds.token)
      || sid !== run.sessionId || run.owned !== true || !['PROBING', 'RUNNING'].includes(run.phase))
      return { applied: false, skipped: 'STATE_CHANGED', name };
    run.sessionName = { key, name, at: Date.now(), ok: ok !== false };
    if (ok === false && !run.notice) run.notice = `改名失败（${name}），只提示，不影响保留/归档决策`;
    automationPersist();
    save();
    return { applied: ok !== false, name, skipped: ok === false ? 'RENAME_FAILED' : null };
  }

  // ── 状态机：探针与任务轮（沿用 E2 的骨架） ─────────────────────────────────

  function automationScheduleCostRead(sid, delay) {
    if (costTimer) return false;
    costTimer = setTimeout(() => {
      costTimer = null;
      void automationRun({ kind: 'COST_READ', sid, trigger: 'COST_READ' });
    }, Math.max(0, automationNumber(delay, 0) || 0));
    return true;
  }

  function automationLockBatch() {
    automationEnsureState();
    const pool = automationPoolSelection();
    const switches = automationSwitches();
    // ★ 卡 G：默认不限（null）；只有用户填了正数才有上限。判 null 绝不当 0。
    const probesLimit = automationLimitValue(config.probeLimit);
    const chargedLimit = automationLimitValue(config.chargedLimitUsd);
    run.batch = {
      poolVersion: pool.version === undefined ? null : pool.version,
      poolPresetId: pool.targetId,
      poolTitle: pool.title || '未命名候选池',
      poolKeys: Array.isArray(pool.keys) ? pool.keys.slice() : [],
      poolCatalogHash: pool.catalogHash,
      probesLimit,
      chargedLimitUsd: chargedLimit,
      lockedAt: Date.now(),
    };
    run.probesUsed = 0;
    run.chargedUsd = 0;
    run.chargedBySid = {};
    run.refetchUsed = 0;
    run.evidenceFinal = false;
    run.batchStopped = false;
    run.batchStopReason = null;
    run.batchStopMessage = null;
    run.missStreak = 0;
    run.hitCount = 0;
    run.hitSids = [];
    run.probeId = null;
    run.archivedSids = [];
    run.terminatedSids = [];
    run.poolAdvisory = null;
    run.decision = null;
    run.policy = null;
    run.notice = null;
    run.lastEvidence = null;
    run.lastArchive = null;
    run.autoNameUnavailable = false;
    run.sessionName = null;
    run.trace = [];
    run.rounds = null;
    run.thinking = { state: 'UNKNOWN', round: null, kind: null, markers: [], complete: false, settleReason: 'NOT_STARTED' };
    run.switches = switches;
    automationPersist();
    return { pool, switches, batch: run.batch };
  }

  function automationStopForPoolAtStart() {
    const policy = automationPolicy(null, {});
    if (policy.decision === 'PAUSE') {
      automationTrace('start:pause-pool');
      automationPauseForPool(policy);
      return true;
    }
    return false;
  }

  function queueNextProbe(reason, token = automationToken) {
    automationEnsureState();
    if (!activeAutomation(token)) return;
    if (automationHumanVerificationVisible()) { stopForHumanVerification(); return; }
    if (run.batchStopped === true) return;
    if (!automationBatchCanContinue()) { automationStopBatch(); return; }
    // ★ 0.6.3：100 条探针"轮内无放回 + 一轮用尽自动轮换"（池为空才兜底停；不再"耗尽即停"）。
    if (automationProbePoolExhausted()) {
      automationTrace('probe:pool-unavailable');
      automationStopBatch('PROBE_EXHAUSTED');
      return;
    }
    run.phase = 'PROBING';
    run.reason = reason || null;
    run.sessionId = null;
    run.owned = false;
    run.retries = 0;
    run.pendingRound = 0;
    run.refetchUsed = 0;
    run.evidenceFinal = false;
    run.rounds = null;
    run.launchFailures = 0;
    automationPersist();
    save();
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      void launchProbeAttempt(token);
    }, Math.max(0, automationNumber(automationTiming.probeGapMs, PROBE_RETRY_GAP_MS) || 0));
  }

  function stopForHumanVerification() {
    clearTimeout(probeTimer); probeTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(roundTimer); roundTimer = null;
    run.phase = 'STOPPED';
    run.reason = 'HUMAN_VERIFICATION';
    run.sessionId = null;
    run.owned = false;
    run.pendingRound = 0;
    run.notice = '页面要求人机验证，已暂停；不尝试自动通过验证，请人工处理后再启动';
    automationPersist();
    save();
    automationNotify(run.notice);
  }

  function failedProbe(reason, token) {
    if (!activeAutomation(token)) return;
    if (reason === 'HUMAN_VERIFICATION' || automationHumanVerificationVisible()) {
      stopForHumanVerification();
      return;
    }
    run.launchFailures = (Number(run.launchFailures) || 0) + 1;
    if (run.launchFailures >= AUTOMATION_LAUNCH_FAILURE_MAX) {
      automationPause('PROBE_LAUNCH_FAILED',
        `连续 ${run.launchFailures} 次未能建立探针会话（${reason}）；已暂停，不新建会话`);
      return;
    }
    queueNextProbe(reason, token);
  }

  async function launchProbeAttempt(token) {
    automationEnsureState();
    if (!activeAutomation(token)) return;
    if (run.batchStopped === true) return;
    if (!automationBatchCanContinue()) { automationStopBatch(); return; }
    if (automationHumanVerificationVisible()) { stopForHumanVerification(); return; }
    // ★ 0.6.3：先判池是否**不可用**（空池才兜底停；一轮用完会自动轮换，不停）。
    if (automationProbePoolExhausted()) {
      automationTrace('probe:pool-unavailable');
      automationStopBatch('PROBE_EXHAUSTED');
      return;
    }

    run.phase = 'PROBING';
    run.attempt += 1;
    run.sessionId = null;
    run.owned = false;
    run.previousSessionId = currentSessionId();
    run.retries = 0;
    run.pendingRound = 0;
    run.verdict = null;
    run.lastCost = null;
    run.reason = null;
    run.refetchUsed = 0;
    run.evidenceFinal = false;
    run.rounds = null;
    automationPersist();
    save();

    const previous = run.previousSessionId;
    const control = findNewAgentControl();
    const current = currentSessionId();
    if (current && control) {
      control.click();
      const deadline = Date.now() + 5000;
      while (currentSessionId() === current && Date.now() < deadline) await wait(100);
    } else if (location.pathname !== '/agent') {
      location.href = '/agent';
      await wait(500);
    }

    // ★ 0.6.3：从 100 条池里**轮内无放回**抽一条（跨刷新持久化 + 轮换由 C 的池负责）；
    //   抽不到只可能是池为空（异常兜底）—— "用尽"会自动开下一轮，不再是停止原因。
    const selected = automationDrawProbe(run.attempt - 1);
    if (!selected) {
      automationTrace('probe:pool-unavailable');
      automationStopBatch('PROBE_EXHAUSTED');
      return;
    }
    run.probeId = selected.probeId;
    run.probeIndex = selected.index;
    automationBeginRound('PROBE', 0);
    const sent = await automationSendText(selected.prompt);
    if (!activeAutomation(token)) return;
    if (!sent) {
      failedProbe('COMPOSER_NOT_FOUND', token);
      return;
    }
    run.probesUsed = (Number(run.probesUsed) || 0) + 1;
    automationPersist();
    const created = await waitForNewSession(previous, token);
    if (!activeAutomation(token)) return;
    if (!created.sid) {
      failedProbe(created.reason || 'NEW_SESSION_NOT_FOUND', token);
      return;
    }
    run.sessionId = created.sid;
    run.owned = true;
    if (!Array.isArray(run.currentRunOwned)) run.currentRunOwned = [];
    run.currentRunOwned.push(created.sid);
    run.reason = selected.probeId
      ? `已发送探针 #${run.attempt}（${selected.probeId}）`
      : `已发送探针 #${run.attempt}（${selected.index + 1}/${selected.total}）`;
    automationPersist();
    save();
    if (run.thinking.state === 'SEEN') void automationRun({ kind: 'THOUGHT', sid: created.sid, trigger: 'STREAM_BOUND', markers: run.thinking.markers });
    automationScheduleCostRead(created.sid, automationTiming.costGapMs);
    automationNotify(`已发送轮换探针 #${run.attempt}：${automationProbeShortLabel(selected)}`);
  }

  function scheduleRound(round) {
    clearTimeout(roundTimer);
    roundTimer = setTimeout(async () => {
      roundTimer = null;
      const token = automationToken;
      if (!activeAutomation(token)) return;
      if (run.phase !== 'RUNNING' || run.owned !== true) return;
      const block = automationAutoSendBlock();
      if (block) { automationStopBatch(block); return; }
      if (automationHumanVerificationVisible()) { stopForHumanVerification(); return; }
      const tasks = String(config.tasks || DEFAULT_TASK).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const prompt = tasks[(round - 1) % tasks.length] || DEFAULT_TASK;
      automationBeginRound('TASK', round);
      automationPersist();
      save();
      const sent = await automationSendText(prompt);
      if (!activeAutomation(token)) return;
      if (!sent) {
        automationPause('ROUND_SEND_FAILED', `第 ${round} 轮任务未能发出（找不到输入框）；已暂停，未归档当前会话`);
        return;
      }
      automationScheduleCostRead(run.sessionId, automationTiming.costGapMs);
    }, Math.max(0, automationNumber(automationTiming.roundGapMs, MIN_COST_GAP_MS) || 0));
  }

  async function startAutomation() {
    automationEnsureState();
    if (!/^\/agent(?:\/|$)/.test(location.pathname)) {
      location.href = '/agent';
      return;
    }
    if (['PROBING', 'RUNNING', 'ARCHIVING'].includes(run.phase) && run.batchStopped !== true) {
      automationNotify('筛选仍在运行；点「停止」才会结束');
      return;
    }
    enableBillingFlag();
    automationToken += 1;
    const token = automationToken;
    clearTimeout(roundTimer); roundTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(probeTimer); probeTimer = null;
    const locked = automationLockBatch();          // 清单 15：锁定「本次池版本 + 预算」
    run.phase = 'PROBING';
    run.sessionId = null;
    run.previousSessionId = currentSessionId();
    run.owned = false;
    run.completedRounds = 0;
    run.pendingRound = 0;
    run.retries = 0;
    run.verdict = null;
    run.lastCost = null;
    run.reason = null;
    run.createdAt = Date.now();
    run.startedAt = Date.now();
    run.attempt = 0;
    run.probeIndex = 0;
    run.launchFailures = 0;
    run.currentRunOwned = [];
    automationPersist();
    save();
    // 清单 15 + 5：开始探测前确认池非空（仅在固定筛选开启时才是硬门禁）
    if (locked.switches.fixedFilter === true && automationStopForPoolAtStart()) return;
    void launchProbeAttempt(token);
  }

  function stopAutomation() {
    automationEnsureState();
    automationToken += 1;
    clearTimeout(roundTimer); roundTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(probeTimer); probeTimer = null;
    automationStopGeneration();
    run.phase = 'STOPPED';
    run.reason = 'USER_STOPPED';
    run.pendingRound = 0;
    if (run.rounds) run.rounds.pending = false;
    automationPersist();
    save();
  }

  /** 恢复：不新建会话、不发消息，只按当前开关对已有证据重判一次（清单 30 的"恢复后应用新规则"）。 */
  async function resumeAutomation() {
    automationEnsureState();
    if (run.batchStopped === true) {
      automationNotify(run.batchStopReason === 'PROBE_EXHAUSTED'
        ? `${AUTOMATION_PROBE_EXHAUSTED_MESSAGE}；请检查脚本部件后重新点「开始」发起新批次`
        : '本批已停止自动探测（停止线）；请重新点「开始」发起新批次');
      return { resumed: false, reason: 'BATCH_STOPPED' };
    }
    if (!run.sessionId || run.owned !== true) {
      automationNotify('没有可恢复的会话：当前会话不是本轮创建的，或已被归档');
      return { resumed: false, reason: 'NO_SESSION' };
    }
    const sid = run.sessionId;
    run.phase = run.rounds && run.rounds.kind === 'TASK' ? 'RUNNING' : 'PROBING';
    run.reason = null;
    automationPersist();
    save();
    await automationRun({ kind: 'RESUME', sid, trigger: 'RESUME', allowPaused: true });
    // 恢复后**按新规则**继续：只有 KEEP（阶段仍在 RUNNING/PROBING）才续发；已归档/已暂停一律不动。
    if (['RUNNING', 'PROBING'].includes(run.phase) && run.owned === true && run.sessionId === sid
      && run.decision === 'KEEP' && run.rounds && run.rounds.outputComplete && run.rounds.billingReady) {
      const total = Math.max(0, Math.floor(automationNumber(config.rounds, 0) || 0));
      const done = Number(run.completedRounds) || 0;
      const kind = run.rounds && run.rounds.kind === 'TASK' ? 'TASK' : 'PROBE';
      if (kind === 'TASK') {
        if (done < total && !automationRoundPending() && !automationAutoSendBlock()) scheduleRound(done + 1);
      } else {
        automationScheduleCostRead(sid, automationTiming.costGapMs);
      }
    }
    return { resumed: true, phase: run.phase };
  }

  /** 池切换（清单 8/20）：就地重判本地报告、取消尚未发送的任务；不自动恢复/续发/重置预算。 */
  async function automationApplyPoolChange() {
    automationEnsureState();
    clearTimeout(roundTimer); roundTimer = null;
    if (automationRoundJudgeable()) run.rounds.pending = false;
    run.pendingRound = 0;
    run.poolChangeCount = (Number(run.poolChangeCount) || 0) + 1;
    // 池是本批锁定的两样东西之一 ⇒ 换池就换锁：**只重锁池，探针上限与 charged 上限原样不动**。
    const pool = automationPoolSelection();
    if (run.batch && typeof run.batch === 'object') {
      run.batch.poolKeys = Array.isArray(pool.keys) ? pool.keys.slice() : null;
      run.batch.poolCatalogHash = pool.catalogHash;
      run.batch.poolTitle = pool.title;
      run.batch.poolPresetId = pool.targetId;
      run.batch.poolRelockedAt = Date.now();
    }
    const verdict = await automationRecheckEvidence('POOL_CHANGE');
    // 已归档会话可重判（只记录结论），**不**自动恢复、**不**自动续发。
    run.archivedRejudge = (Array.isArray(run.archivedSids) ? run.archivedSids : []).map((sid) => ({
      sid, at: Date.now(), decision: run.policy ? run.policy.decision : null,
      note: '已归档会话按新池重判：不自动恢复、不自动续发消息',
    }));
    automationPersist();
    save();
    return { switches: automationSwitches(), policy: run.policy, verdict };
  }

  /** 开关切换（清单 30）：不立即归档、不自动发消息；先暂停后续自动发送，再重判已有证据。 */
  async function automationApplySwitchChange() {
    automationEnsureState();
    clearTimeout(roundTimer); roundTimer = null;
    clearTimeout(costTimer); costTimer = null;
    clearTimeout(probeTimer); probeTimer = null;
    if (automationRoundJudgeable()) run.rounds.pending = false;
    run.pendingRound = 0;
    run.phase = 'PAUSED';
    run.reason = 'SWITCH_CHANGED';
    run.notice = '开关已切换：已暂停后续自动发送并重判已有证据；恢复后按新规则执行';
    run.switches = automationSwitches();
    automationPersist();
    save();
    const verdict = await automationRecheckEvidence('SWITCH_CHANGE');
    return { switches: run.switches, verdict };
  }

  /** 只重判（不动作）：拿当前证据/池/开关重算 A′ 判定并记录。 */
  async function automationRecheckEvidence(trigger) {
    automationEnsureState();
    const sid = run.sessionId;
    const evidence = await automationCollectEvidence(sid, { fetch: false });
    const policy = automationPolicy(evidence.report, {});
    run.switches = automationSwitches();
    run.recheck = { trigger: trigger || 'RECHECK', at: Date.now(), decision: policy.decision, reason: policy.reason };
    automationPersist();
    save();
    return { decision: policy.decision, reason: policy.reason, report: !!evidence.report };
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function notify(message) {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: 2147483647, background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: '8px', font: '13px system-ui', boxShadow: '0 4px 18px #0005' });
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function findNewAgentControl() {
    return [...document.querySelectorAll('a,button,[role="button"]')]
      .filter(isVisible)
      .find((el) => {
        const t = textOf(el);
        let href = '';
        try { href = new URL(el.href, location.href).pathname; } catch (_) {}
        return /new chat|new agent|新建|新对话|新聊天/i.test(t) || href === '/agent';
      });
  }

  async function waitForNewSession(previous, token) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (token !== undefined && !activeAutomation(token)) return { sid: null, reason: 'CANCELLED' };
      if (automationHumanVerificationVisible()) return { sid: null, reason: 'HUMAN_VERIFICATION' };
      const sid = currentSessionId();
      if (sid && sid !== previous) return { sid, reason: null };
      await wait(250);
    }
    return { sid: null, reason: 'NEW_SESSION_NOT_FOUND' };
  }

  // ── 事件入口（20-network.js 调的就是这两个 + discardOwnedProbe） ───────────

  /** /cost 回调：E 的 observeResponse / XHR / 计划重取都会走到这里（同步返回，内部异步）。 */
  function onCost(sid, evidence, meta) {
    const info = meta && typeof meta === 'object' ? meta : {};
    void automationRun({
      kind: 'COST', sid, evidence: evidence || null,
      status: info.status === undefined ? null : info.status,
      costRequestedAt: info.requestedAt || Date.now(),
      roundToken: info.roundToken, automationToken: info.automationToken,
      trigger: 'COST',
    });
  }

  /** 思考流回调：**不再无条件 discard**；按开关二（不管/要/不要）处理。 */
  function onThought(sid, markers, source) {
    void automationRun({
      kind: 'THOUGHT', sid,
      markers: Array.isArray(markers) ? markers.slice() : [],
      // ★ R2：命中来源（页面上渲染出来的 thinking 标签 = 'dom'，本版唯一通道）。
      source: typeof source === 'string' && source ? source : 'dom',
      trigger: 'THOUGHT',
    });
  }

  /**
   * 20-network.js 的 scheduleCostFetch 在"费用读不到"时会调这里（保留旧签名）。
   * 新语义：只读重取已耗尽 ⇒ evidenceFinal=true，交给主流水线按 A′ 的最终判定处理。
   */
  function discardOwnedProbe(reason, label, token = automationToken) {
    automationEnsureState();
    if (!activeAutomation(token)) return;
    if (reason === 'HUMAN_VERIFICATION' || automationHumanVerificationVisible()) {
      stopForHumanVerification();
      return;
    }
    const sid = run.sessionId;
    if (!sid || run.owned !== true) {
      queueNextProbe(reason, token);
      return;
    }
    // 只读重取已经用尽（E 的 scheduleCostFetch 在读不到费用时调这里）：定稿 → 主流水线按 A′ 最终判定处理。
    run.evidenceFinal = true;
    run.autoNameUnavailable = true;
    if (run.thinking && typeof run.thinking === 'object') {
      run.thinking = Object.assign({}, run.thinking, { complete: false, incompleteReason: 'EVIDENCE_EXHAUSTED' });
    }
    if (label) run.notice = `费用证据不可用（${label}）：已置 evidenceFinal=true`;
    automationPersist();
    automationTrace(`evidence-exhausted:${reason || 'COST_UNAVAILABLE'}`);
    save();
    void automationRun({ kind: 'COST_EXHAUSTED', sid, trigger: reason || 'COST_UNAVAILABLE', forceFinal: true });
  }

  // ── 对外接口 / 测试接口 ────────────────────────────────────────────────────

  function automationState() {
    automationEnsureState();
    const pool = automationProbePoolInfo();
    return {
      phase: run.phase, reason: run.reason, sessionId: run.sessionId, owned: run.owned,
      switches: automationSwitches(), batch: run.batch || null, stopLine: automationStopLineSnapshot(),
      decision: run.decision || null, policy: run.policy || null, poolAdvisory: run.poolAdvisory || null,
      thinking: run.thinking ? { state: run.thinking.state, round: run.thinking.round, markers: (run.thinking.markers || []).slice() } : null,
      sessionName: run.sessionName || null, autoNameUnavailable: run.autoNameUnavailable === true,
      notice: run.notice || null, batchStopped: run.batchStopped === true, batchStopMessage: run.batchStopMessage || null,
      batchStopReason: run.batchStopReason || null,
      refetchUsed: Number(run.refetchUsed) || 0, evidenceFinal: run.evidenceFinal === true,
      // ★ 卡 G：不限口径 + 未命中/命中计数 + 剩余探针（面板文案的数据源）。
      limits: {
        probesLimit: automationProbeLimitOf(), chargedLimitUsd: automationChargedLimitOf(),
        probesLabel: automationLimitLabel(automationProbeLimitOf()),
        chargedLabel: automationLimitLabel(automationChargedLimitOf()),
        unlimited: automationProbeLimitOf() === null && automationChargedLimitOf() === null,
        probeInput: config.probeLimit === undefined ? null : config.probeLimit,
        chargedInput: config.chargedLimitUsd === undefined ? null : config.chargedLimitUsd,
      },
      probesUsed: Number(run.probesUsed) || 0,
      archivedCount: Array.isArray(run.archivedSids) ? run.archivedSids.length : 0,
      hitCount: Number(run.hitCount) || 0,
      missStreak: Number(run.missStreak) || 0,
      probeId: run.probeId || null,
      probePool: pool,
      probePoolExhausted: automationProbePoolExhausted(),
      archivedSids: Array.isArray(run.archivedSids) ? run.archivedSids.slice() : [],
      trace: Array.isArray(run.trace) ? run.trace.slice() : [],
      evidenceCount: automationEvidenceList().length,
    };
  }

  const automationApi = {
    state: automationState,
    statusLines: automationStatusLines,
    switches: automationSwitches,
    pool: automationPoolSelection,
    batch: () => run.batch || null,
    nameFor: automationNameFor,
    evidence: automationEvidenceList,
    evidenceText: automationEvidenceExportText,
    applyPoolChange: automationApplyPoolChange,
    applySwitchChange: automationApplySwitchChange,
    recheck: automationRecheckEvidence,
    resume: resumeAutomation,
    markThinkingIncomplete: automationMarkThinkingIncomplete,
    batchStopMessage: automationBatchStopMessage,
    // ★ 卡 G：上限读写（null = 不限；面板输入也走这两个口，非法输入不写状态）
    limits: () => automationState().limits,
    limitLabel: automationLimitLabel,
    setProbeLimit: (raw) => automationSetLimit('probeLimit', raw),
    setChargedLimit: (raw) => automationSetLimit('chargedLimitUsd', raw),
    probePool: automationProbePoolInfo,
    // ★ 卡 G：面板文案数据源（40-panel.js 直接用；也是离线断言的对象）
    panelLimitsLines: automationPanelLimitsLines,
    panelProgressLine: automationPanelProgressLine,
    panelRemainingLine: automationPanelRemainingLine,
    panelCycleLine: automationPanelCycleLine,
    panelMissLine: automationPanelMissLine,
    panelSummaryLine: automationPanelSummaryLine,
    panelStatusPhrase: automationPanelStatusPhrase,
    panelPoolShort: automationPanelPoolShort,
    panelVerdictLines: automationPanelVerdictLines,
    candidatesPreview: automationCandidatesPreview,
    historyPreview: automationHistoryPreview,
    storageKeys: { state: AUTOMATION_STATE_STORAGE, evidence: AUTOMATION_EVIDENCE_STORAGE, panel: AUTOMATION_PANEL_STORAGE },
  };

  const automationTestApi = {
    state: automationState,
    statusLines: automationStatusLines,
    switches: automationSwitches,
    pool: automationPoolSelection,
    policy: automationPolicy,
    policyOptions: automationPolicyOptions,
    applyPoolChange: automationApplyPoolChange,
    applySwitchChange: automationApplySwitchChange,
    recheck: automationRecheckEvidence,
    resume: resumeAutomation,
    markThinkingIncomplete: automationMarkThinkingIncomplete,
    batchStopMessage: automationBatchStopMessage,
    batchStop: automationStopBatch,
    stopLine: automationStopLineSnapshot,
    stopLineBlock: automationAutoSendBlock,
    batchCanContinue: automationBatchCanContinue,
    // ★ 卡 G：上限 / 探针池 / 旧配置迁移（全部可离线断言）
    limitValue: automationLimitValue,
    limitLabel: automationLimitLabel,
    limitInput: automationLimitInput,
    limitInvalidHint: () => AUTOMATION_LIMIT_INVALID_HINT,
    setLimit: automationSetLimit,
    chargeBlock: automationChargeBlock,
    probeLimitBlock: automationProbeLimitBlock,
    probePoolInfo: automationProbePoolInfo,
    probePoolExhausted: automationProbePoolExhausted,
    drawProbe: automationDrawProbe,
    probeShortLabel: automationProbeShortLabel,
    migrateLimits: automationMigrateLimits,
    panelLimitsLines: automationPanelLimitsLines,
    panelProgressLine: automationPanelProgressLine,
    panelRemainingLine: automationPanelRemainingLine,
    panelCycleLine: automationPanelCycleLine,
    panelMissLine: automationPanelMissLine,
    panelSummaryLine: automationPanelSummaryLine,
    panelStatusPhrase: automationPanelStatusPhrase,
    panelPoolShort: automationPanelPoolShort,
    panelVerdictLines: automationPanelVerdictLines,
    candidatesPreview: automationCandidatesPreview,
    historyPreview: automationHistoryPreview,
    run: (ctx) => automationRun(ctx),
    keepSession: automationKeepSession,
    archiveSession: automationArchiveSession,
    applyNaming: automationApplyNaming,
    evidenceList: automationEvidenceList,
    evidenceText: automationEvidenceExportText,
    buildEvidenceRecord: automationBuildEvidenceRecord,
    persist: automationPersist,
    // 纯函数
    keyCompare: automationKeyCompare,
    clusters: automationClusters,
    fallbackClusters: automationFallbackClusters,
    visibleLength: automationVisibleLength,
    composeName: automationComposeName,
    nameCandidates: automationNameCandidates,
    nameFor: automationNameFor,
    nameOutcome: automationNameOutcome,
    thinkingDecision: automationThinkingDecision,
    normalizeThinkingMode: automationNormalizeThinkingMode,
    settleThinking: automationSettleThinking,
    beginRound: automationBeginRound,
    streamRecord: automationStreamRecord, streamStart: automationStreamStart, streamEvent: automationStreamEvent, billReady: automationBillReady,
    recordThoughtMarkers: automationRecordThoughtMarkers,
    // ★ DOM 判据（唯一思考通道）：读页面标签 + 手动跑一次扫描（离线测试注入假 DOM 后驱动）。
    domThinkingLabel: automationDomThinkingLabel,
    sweepDomThinking: automationSweepDomThinking,
    domThinkingHits: () => domThinkingHits,
    // 注入假实现 / 调时序
    timing: automationTiming,
    setFetchCostOnce(fn) { automationFetchCostOnce = fn; },
    setArchiveAndVerify(fn) { automationArchiveAndVerify = fn; },
    setSendText(fn) { automationSendText = fn; },
    setIdentifyReport(fn) { automationIdentifyReport = fn; },
    setIdentifyPolicy(fn) { automationIdentifyPolicy = fn; },
    setRenameForArchive(fn) { automationRenameForArchive = fn; },
    setRename(fn) { automationRename = fn; },
    setStopGeneration(fn) { automationStopGeneration = fn; },
    setNotify(fn) { automationNotify = fn; },
    setHumanVerification(fn) { automationHumanVerificationVisible = fn; },
    setIsGenerating(fn) { automationIsGenerating = fn; },
    setGraphemeSegmenter(flag) { automationUseIntlSegmenter = flag !== false; },
    getRefs() {
      return {
        fetchCostOnce: automationFetchCostOnce, archiveAndVerify: automationArchiveAndVerify,
        sendText: automationSendText, identifyReport: automationIdentifyReport,
        identifyPolicy: automationIdentifyPolicy, renameForArchive: automationRenameForArchive,
        rename: automationRename, stopGeneration: automationStopGeneration,
      };
    },
  };

  // ── 挂载（不碰 60-bootstrap.js：它整体赋值 window.__ARENA_AGENT_BILLING__） ──
  // 与 C 卡 probePoolExpose 同一思路：备用入口 + 延迟挂载（bootstrap 结束后再合并进去）。
  function automationMount(target) {
    if (!target || typeof target !== 'object') return target;
    if (!target.automation) target.automation = automationApi;
    if (!target.__test__ || typeof target.__test__ !== 'object') target.__test__ = {};
    target.__test__.automation = automationTestApi;
    return target;
  }

  function automationExpose(target) {
    if (!target || typeof target !== 'object') return;
    try { target.__ARENA_AGENT_BILLING_AUTOMATION__ = automationApi; } catch (_) {}
    try {
      const ns = target.__ARENA_AGENT_BILLING__;
      if (ns && typeof ns === 'object') automationMount(ns);
      else if (typeof setTimeout === 'function') {
        setTimeout(() => {
          try {
            const late = target.__ARENA_AGENT_BILLING__;
            if (late && typeof late === 'object') automationMount(late);
          } catch (_) {}
        }, 0);
      }
    } catch (_) {}
  }

  automationExpose(typeof window !== 'undefined' ? window : null);

  // ★ 卡 G · 旧配置迁移（一次性、幂等）：已保存配置恰为旧默认 2 条 / $0.10 ⇒ 改成不限；
  //   自定义限制保留；**不重置** probesUsed / chargedUsd（这里根本不碰这两个计数）。
  try { automationMigrateLimits(); } catch (_) {}

  // 面板临时接线（40-panel.js 归 B′）：只包一层 renderStatus 追加自动化字段，B′ 接线后可删。
  if (typeof renderStatus === 'function' && !renderStatus.__automationWrapped__) {
    const automationBaseRenderStatus = renderStatus;
    renderStatus = function automationRenderStatus() {
      automationBaseRenderStatus.apply(this, arguments);
      try {
        const p = (typeof panel !== 'undefined' && panel) ? panel : null;
        if (!p || !p.status) return;
        const current = String(p.status.textContent || '');
        const lines = automationStatusLines().filter((line) => line && !current.includes(line));
        if (!lines.length) return;
        p.status.textContent = current + '\n' + lines.join('\n');
      } catch (_) {}
    };
    renderStatus.__automationWrapped__ = true;
  }
// ─────────────────────────────────────────────────────────────────────────────
  // C · 探针池：100 条互不重复的自然语言开场语
  //     轮内无放回抽取（crypto.getRandomValues）+ 跨刷新持久化（localStorage）+ **一轮用尽自动轮换**
  //
  // 为什么这么做（用户原话 / GPT 决策 Q4）：
  //   "允许你开新会话，但是开新会话发消息时候，开头要是不同的，相同的字母容易触发人机。"
  //   ⇒ 用**本地审核过的自然语言变体池**、无放回抽取；**不用**随机乱码。
  //   ⇒ 不插 UUID、随机字母串、零宽字符、噪声填充（没有已验证收益，还会改变 token profile）。
  //   ⇒ 旧实现（32 条）池耗尽就暂停；**用户 2026-10-11 明确要求"至少 100 个素材，然后 100 个
  //      素材可以轮换"** ⇒ 0.6.3 起：一轮内仍然无放回，一轮用尽后**自动进入下一轮**（每轮
  //      重新洗牌、新轮首条 ≠ 上一轮末条），**不再**因为"用尽"暂停；只有池本身为空
  //      （部件缺失/被改坏）才走兜底停。（更早的实现是 parts/30-automation.js 的
  //      probeForAttempt() 按 config.probe 每行取模循环 —— 那是"每轮固定顺序"，已废弃。）
  //
  // 每条探针的形态（GPT 决策 Q5；材料长度口径按用户 2026-10-11 会话指示修订）：
  //   一句互不相同的自然语言首句 + 一段**短素材** + 一句"请用 50–100 tokens 短答"。
  //   短素材 = 非空白 6–60 字、1–3 行（用户原话：「这里只需要准备一些很短的素材就可以了，
  //   因为我们只需要很短的内容，就可以抓出它具体的额度」「甚至只需要几个字、几十个字不一样
  //   就可以了；不一样的话，就可以避免人机感。也不是说只要不重复就可以。这样让它回复快点，
  //   我们检测得也快点」）。旧口径「200–400 tokens 的成段材料」已作废（助手复核用不着那么长，
  //   短素材还能让目标回合更快结束 ⇒ 更快读到 /cost）。
  //   任务类型统一为：短素材整理 / 字段提取 / 简单计数 / 排序 / 单位换算说明；
  //   都不需要工具、联网或多轮。不附大段重复语料、不做预热、不为 cache read 另开一轮。
  //   ⚠ 「50–100」是**估算**（不是实测 tokenizer 计数）；短素材的硬约束是**字符数**：
  //     非空白 6–60 字、1–3 行无空行，且素材起手 6 字两两不同、两两最长公共子串 ≤12
  //     （挡"同一模板换词"——用户说「也不是说只要不重复就可以」）。
  //     逐条口径与实测见 test/run-probe-pool-tests.mjs 的 A/B 段。
  //
  // 本部件只负责"池"本身（抽取 / 轮换 / 持久化 / 面板文案 / 可复现记录）：
  //   · 状态机从池里抽、不再循环复用（卡片 D 只调这里的接口）；
  //   · 面板的最终排版是卡片 B（本部件在 renderStatus 上临时挂一行，B/D 落地后删掉即可）。
  //   · 池里不含任何外发请求、不绕过人机验证、不自动点击任何验证控件。
  // ─────────────────────────────────────────────────────────────────────────────

  const PROBE_POOL_VERSION = 'probe-pool-v1';
  const PROBE_POOL_STORAGE = 'arena-agent-billing:probe-pool:v1';
  const PROBE_POOL_LOG_LIMIT = 50;   // 运行日志保留条数（写进 localStorage，供面板/复核追溯）
  const PROBE_POOL_SUMMARY_MAX = 40; // 面板首句摘要的最大字符数（验收要求 ≤ 40）

  // 100 条探针：first / material / ask **逐条手写**，没有循环拼模板，也没有"同一句加编号"。
  // material 一律是**短素材**（非空白 6–60 字，1–3 行）；text 只是把三段按固定顺序接起来
  // （probePoolText 只拼接、不生成内容）。
  const PROBE_POOL = [
    { id: "P01", first: "帮我把下面这段小组例会的记录收成三条要点，别加自己的评论。", material: "例会记录：\n值班表、报销单、团建时间", ask: "请用 50 到 100 个字回答：写成三条要点，一行一条。" },
    { id: "P02", first: "手边有一份读书清单，麻烦按页数从少到多帮我排一下。", material: "《城南旧事》218 页\n《活着》156 页\n《围城》302 页", ask: "用 50 到 100 个字回答：按页数从少到多，一行一本。" },
    { id: "P03", first: "这份租车结算单的信息有点散，我想先把关键字段抠出来。", material: "租车单：车型 朗逸；取车 10 月 3 日；还车 10 月 6 日；押金 500", ask: "请用 50 到 100 个字回答：字段名与取值一行一条。" },
    { id: "P04", first: "数一下下面这段场地说明里“备用”这个词出现了几次，顺便标出所在句子。", material: "场地说明：备用电源 2 处，备用桌椅 4 套，其余物资已清点，备用区暂不开放。", ask: "用 50 到 100 个字回答：先给次数，再说分别在哪一句。" },
    { id: "P05", first: "几个维修工单的日期顺序乱了，你能替我理一下先后吗？", material: "工单：3 月 8 日 换灯；3 月 2 日 修门；3 月 15 日 通下水", ask: "请用 50 到 100 个字回答：按日期从早到晚排，一行一条。" },
    { id: "P06", first: "这周的天气播报稿太长，帮我压成三句话。", material: "播报稿：\n周三晴 12–20℃；周四阴有小雨；周五转晴", ask: "用 50 到 100 个字回答：压成三句话，别加评论。" },
    { id: "P07", first: "我不太确定公里和英里怎么换算，下面这组里程你能不能统一成公里？", material: "里程：\n3.5 英里、8 英里、12.4 英里", ask: "请用 50 到 100 个字回答：全部换成公里，保留一位小数。" },
    { id: "P08", first: "两份物资申领单合在一起以后有重复，帮我判断哪些是重复项。", material: "甲单：帐篷 2、睡袋 4\n乙单：睡袋 4、手电 3", ask: "用 50 到 100 个字回答：先列重复项，再列只在一边的。" },
    { id: "P09", first: "有个包裹面单的内容我抄下来了，需要你拆成字段。", material: "面单：收件人 李；电话 1380000；地址 光明路 7 号；到付", ask: "请用 50 到 100 个字回答：拆成字段，一行一条。" },
    { id: "P10", first: "冰箱里剩下的东西我列了一下，想按类别归归拢。", material: "冰箱：鸡蛋 6 个、酸奶 2 盒\n冷藏室还有半棵白菜、一块豆腐", ask: "用 50 到 100 个字回答：按类别归拢，每类一行。" },
    { id: "P11", first: "说明书这段我读着费劲，你替我提炼要点。", material: "说明书：首次使用先空烧 5 分钟；每次用完擦干；勿浸水。", ask: "请用 50 到 100 个字回答：提炼成三条要点。" },
    { id: "P12", first: "排班表在下面，请把它改成一人一行的清单。", material: "排班：周一 早班 王、晚班 李\n周二 早班 赵", ask: "用 50 到 100 个字回答：改成一人一行，写清班次。" },
    { id: "P13", first: "仓库盘点的小票在这儿，帮我算一下总数。", material: "盘点：螺丝 120 个、垫片 3 包共 84 个、铰链 16 个", ask: "请用 50 到 100 个字回答：先给总数，再按品名列。" },
    { id: "P14", first: "昨晚那场球我看了一半，这段赛况帮我缩成几句。", material: "赛况：上半场 1:0；下半场连丢两球，终场 1:2。", ask: "用 50 到 100 个字回答：缩成两三句，说清比分。" },
    { id: "P15", first: "烤箱温度我拿不准，这里有一组摄氏读数，换算成华氏。", material: "烤箱：180℃、200℃、220℃", ask: "请用 50 到 100 个字回答：全部换成华氏，一行一个。" },
    { id: "P16", first: "两份书单看着差不多，帮我看看有没有重复的条目。", material: "书单甲：《活着》《围城》\n书单乙：《围城》《边城》", ask: "用 50 到 100 个字回答：指出重复条目，再说差异。" },
    { id: "P17", first: "课程表截图上的内容我打成了文字，需要抽出关键字段。", material: "课程：高等数学 周一 3-4 节 教三 201；英语 周三 1-2 节 教一 105", ask: "请用 50 到 100 个字回答：抽出课程、时间、地点三列。" },
    { id: "P18", first: "待办事项堆了一屏，麻烦按紧急程度重新排。", material: "待办：交报表（急）截止 10/12\n订机票（中）10/20\n整理照片（缓）11/05", ask: "用 50 到 100 个字回答：按紧急程度排，一行一条。" },
    { id: "P19", first: "实验记录写得比较碎，请归纳成一段简短说明。", material: "实验记录：\n第一批 3 次失败；第二批 1 次；第三批 2 次", ask: "用 50 到 100 个字回答：写成一段简短说明，含次数。" },
    { id: "P20", first: "报价单上有几个方案，按价格从低到高列一下。", material: "方案 A 报价 3200；方案 B 报价 2750；方案 C 报价 4100", ask: "请用 50 到 100 个字回答：按价格从低到高，一行一个。" },
    { id: "P21", first: "配方里用的是盎司，我只有克秤，帮我把单位统一。", material: "配方：黄油 4 盎司、糖 2 盎司", ask: "用 50 到 100 个字回答：换成克，一行一条。" },
    { id: "P22", first: "两个部门的名单要合并，注意重名与兼任的情况。", material: "技术部：张伟、李娜\n市场部：张伟（兼）、王强", ask: "请用 50 到 100 个字回答：合并名单，标出重名与兼任。" },
    { id: "P23", first: "出差行程的文字版在下面，请把车次和住宿信息抽出来。", material: "行程：G1234 次 10:05 开；住 如家 两晚；返程 D567 次", ask: "用 50 到 100 个字回答：抽车次与住宿，一行一条。" },
    { id: "P24", first: "几个会议邀请时间打架了，帮我排个先后并指出来。", material: "会议：9:30 评审；9:00 站会；11:00 面试", ask: "请用 50 到 100 个字回答：排出先后并指出冲突。" },
    { id: "P25", first: "这段社区活动的通稿有点长，缩成一小段。", material: "活动通稿：周六上午义诊，下午亲子手工，晚饭后有露天电影。", ask: "用 50 到 100 个字回答：缩成一小段，保留时间。" },
    { id: "P26", first: "候选方案各有评分，请按总分排序并给出前两名。", material: "评分：甲 82、乙 91、丙 76、丁 88", ask: "请用 50 到 100 个字回答：按总分排，给前两名。" },
    { id: "P27", first: "这页流水账里有若干笔支出，帮我按类别汇总笔数。", material: "流水：餐费 3 笔、交通 2 笔、打印 1 笔、餐费补记 1 笔", ask: "用 50 到 100 个字回答：按类别给笔数，一行一类。" },
    { id: "P28", first: "饮料配方写的是加仑，我想换成升。", material: "配方：加水 2 加仑、糖浆半加仑", ask: "请用 50 到 100 个字回答：换成升，保留一位小数。" },
    { id: "P29", first: "词条表里有些说法其实是同一个意思，帮我判断哪些可以合并。", material: "词条：\n“充电宝”“移动电源”\n“截图”“截屏”", ask: "用 50 到 100 个字回答：指出可合并的说法。" },
    { id: "P30", first: "设备台账抄在下面，请把编号、位置、状态三个字段分开列。", material: "台账：A-12 三楼主控 正常；B-07 地下泵房 待修", ask: "请用 50 到 100 个字回答：编号、位置、状态分三列。" },
    { id: "P31", first: "客服工单的原始描述在下面，帮我归类成一句话结论。", material: "工单原文：用户说 App 打不开，重启后仍旧，怀疑版本旧。", ask: "用 50 到 100 个字回答：归成一句话结论，再列可能原因。" },
    { id: "P32", first: "这份内部花名册的顺序是乱的，请按部门分组再按入职年份排。", material: "花名册：市场部 2019 入职 3 人；技术部 2021 入职 2 人", ask: "请用 50 到 100 个字回答：按部门分组、组内按年份排。" },
    { id: "P33", first: "药箱好久没清了，你帮我归归类。", material: "药箱：感冒药 2 盒（过期）、创可贴 1 包、退烧药 1 瓶", ask: "用 50 到 100 个字回答：按类别归拢，标出过期的。" },
    { id: "P34", first: "民宿退房前我挨屋转了一圈，东西有点乱。", material: "退房清点：\n主卧 台灯一个；厨房 锅铲两把；阳台 晾衣架", ask: "请用 50 到 100 个字回答：按房间归类，一行一间。" },
    { id: "P35", first: "合唱团群里刷了一屏排练安排，", material: "排练单：8日晚7点合练，12日下午2点走台；\n19日全天外地演出，6点半校门集合。", ask: "请用 50 到 100 个字回答：按时间归纳成要点，一行一条，写日期和事项。" },
    { id: "P36", first: "花店这周的进货条子攒了一沓，", material: "花店本周进货：红玫瑰60支、白玫瑰30支；\n多肉12盆、琴叶榕3盆；缎带3卷。", ask: "请用 50 到 100 个字回答：按品类归纳，一行一类，只写品名和数量。" },
    { id: "P37", first: "二手相机那笔交易我记了张单子，", material: "相机转让备忘：机身快门2万次，卡口有浅划痕；\n35mm定焦镜片一粒灰，附两块电池。", ask: "请用 50 到 100 个字回答：归纳成三行，行首写类别，瑕疵要留着。" },
    { id: "P38", first: "校运会借器材的条子我收了一叠，", material: "器材借还登记：起跑器4副缺2颗钉；接力棒8根，\n1根有磕痕；跳高垫2块，绑带断过。", ask: "请用 50 到 100 个字回答：归纳成一种器材一行，写名称、数量和借的班级。" },
    { id: "P39", first: "茶馆那几张会员卡规则写得太绕，", material: "储值卡充300送30，赠额不能单用；10次卡180元，不含茶点；\n家庭卡可登记3人。", ask: "请用 50 到 100 个字回答：一种卡归纳一行，写成「卡种：能用的范围」。" },
    { id: "P40", first: "宠物医院复诊完塞给我一张交代单，", material: "复诊交代：早晚饭后各半片，吐了隔2小时补；\n7天后复查血常规，来前4小时别喂食。", ask: "请用 50 到 100 个字回答：按用药、饮食、观察、复诊归纳，各写一行。" },
    { id: "P41", first: "快递驿站的取件通知堆了一屏，", material: "驿站到件：\n4821 昨15:18；0973 今09:05；7208 上周六12:30。", ask: "请用 50 到 100 个字回答：按到件时间排，一行一件，写尾数和时刻。" },
    { id: "P42", first: "甜品店门口的取号牌我拍下来了，", material: "取号：A017 13:20；B003 13:05；A012 13:12。", ask: "请用 50 到 100 个字回答：按取号时间从早到晚，只写号码和时间。" },
    { id: "P43", first: "图书馆书架上那几本书的页数我抄了，", material: "页数抄录：\n《山南旧事》312页；《桥下人家》194页；《河湾手记》406页。", ask: "请用 50 到 100 个字回答：按页数从少到多，一行一本，写书名和页数。" },
    { id: "P44", first: "青旅前台那张房价表我看不清，", material: "房价（平日）：六人间68、四人间88、双人间158、单人间128、帐篷位45。", ask: "请用 50 到 100 个字回答：按平日价从低到高，一行一种房型。" },
    { id: "P45", first: "登山队那份打卡表上的海拔我抄下来了，", material: "打卡点海拔：山门320米、凉亭760米、碎石坡1080米、垭口1450米。", ask: "请用 50 到 100 个字回答：按海拔从低到高，一行一个点，写名称和海拔。" },
    { id: "P46", first: "摄影比赛那批评分我整理不动了，", material: "初评：雨巷86/82/88，晨渡79/91/84，旧站93/87/90。", ask: "请用 50 到 100 个字回答：按平均分从高到低排，写作品名和分数。" },
    { id: "P47", first: "一箱老唱片的发行年份我记混了，", material: "唱片年份：南风夜曲1979、夏夜小调1983、河畔三重奏1971、远山回声1966。", ask: "请用 50 到 100 个字回答：按发行年份从早到晚，只写名称和年份。" },
    { id: "P48", first: "装修队给的工序表前后顺序乱，", material: "工序工期：拆旧2天、水电5天、防水3天、贴砖6天、木工4天、油漆7天。", ask: "请用 50 到 100 个字回答：按天数从少到多，一行一道工序。" },
    { id: "P49", first: "旧手机拿去以旧换新，报价我记了几条。", material: "检测记录：屏幕浅划痕；电池健康度78%，扣50；\n扬声器有杂音；电池官方换过。", ask: "请用 50 到 100 个字回答：按外观、电池、功能归并，一块一行，别写金额。" },
    { id: "P50", first: "露营前我把要带的东西列了一堆。", material: "露营清单：帐篷1顶、地钉12根、睡袋2个；\n炉子1个、气罐2瓶、头灯2个（1个不亮）。", ask: "请用 50 到 100 个字回答：按类别归并，一块一行，坏的必须标出来。" },
    { id: "P51", first: "篮球队体测成绩单在我手上，", material: "折返跑成绩：陈熙11.2秒、周牧12.8秒、林阔10.9秒、赵桓13.4秒。", ask: "请用 50 到 100 个字回答：按折返跑用时从少到多，只写姓名和用时。" },
    { id: "P52", first: "面包房的出炉时刻表贴歪了，", material: "出炉时刻：吐司6:50、法棍7:10、可颂7:40、碱水结8:00。", ask: "请用 50 到 100 个字回答：按出炉时刻排，一行一种，写名称和时刻。" },
    { id: "P53", first: "邮票册里那张面值表我抄下来了，", material: "面值记录：纪念票8分、普通票4分、欠资票2分、小型张1元2角。", ask: "请用 50 到 100 个字回答：按面值从小到大，一行一枚，写名称和面值。" },
    { id: "P54", first: "修车厂的工位排期我看花眼了，", material: "工位空档：1号9点到11点、2号8点半到10点、4号7点50到9点10。", ask: "请用 50 到 100 个字回答：按空闲开始时刻排，只写工位号和时段。" },
    { id: "P55", first: "种子袋上写的发芽天数我没记全，", material: "发芽天数：樱桃萝卜5-7天、小白菜3-5天、生菜7-10天、香菜10-15天。", ask: "请用 50 到 100 个字回答：按发芽天数从短到长，写菜名和天数。" },
    { id: "P56", first: "门诊预约那张单子我照着抄了下来，帮我抠字段。", material: "门诊预约：周敏，34岁，呼吸内科；\n就诊11月14日9:20，序号A36。", ask: "请用 50 到 100 个字回答：一行一个字段，写成「字段名＝取值」。" },
    { id: "P57", first: "宠物店寄养登记那张卡片，内容我要整理成字段。", material: "寄养卡：豆包，比熊，公，2岁半；主人陈立；\n入店12月3日，押金500，怕打雷。", ask: "请用 50 到 100 个字回答：每行一个字段，写成「字段名：取值」。" },
    { id: "P58", first: "婚宴回执的那一叠小纸条，帮我把信息归成字段。", material: "回执：李建国一家3口，出席，想坐主桌；\n赵小雨带1位同伴，吃素；孙老师要靠窗那桌。", ask: "请用 50 到 100 个字回答：一行一位客人，分「姓名／人数／备注」三列。" },
    { id: "P59", first: "农机租赁那份合同我摘了几行，需要拆成字段。", material: "租赁摘录：承租刘庆丰；机具久保田收割机；\n租期9月20日到10月5日，日租240元。", ask: "请用 50 到 100 个字回答：只列字段名和取值，一行一条，缺失写未填。" },
    { id: "P60", first: "琴行那张维修单我看不太懂，帮我抽出字段来。", material: "维修单：客户许安然；立式钢琴两键回弹慢；\n送修11月8日；调律180元，换毡垫30元。", ask: "请用 50 到 100 个字回答：输出两列，左边字段名右边取值，缺的写未填。" },
    { id: "P61", first: "茶站收茶的那张单据，帮我把字段抄明白。", material: "收购单：农户吴有田，上坑组；4月17日；\n毛重38斤，扣杂后按35斤；单价12元。", ask: "请用 50 到 100 个字回答：一行一个字段，用冒号分隔，没提的写未填。" },
    { id: "P62", first: "看房那天的记录我随手写了几行，需要提字段。", material: "看房记录：临江路9号院两室一厅，租2300；\n地铁口老楼一室一厅，租1900含物业。", ask: "请用 50 到 100 个字回答：先写房号，再写字段名和取值，缺的写未填。" },
    { id: "P63", first: "驾校那份学员档案，我想把里面的字段理出来。", material: "学员档案：郭春燕；报考C1，报名3月9日；\n科一94分，科二补考一次，教练是马师傅。", ask: "请用 50 到 100 个字回答：只输出字段与取值，一行一条，没填的写未填。" },
    { id: "P64", first: "中药房给的那张方子抄件，帮我拆成字段。", material: "药方抄件：田素芬；每日一剂，水煎两次；\n黄芪30克、当归12克，共12味，三味先煎。", ask: "请用 50 到 100 个字回答：一行一味药，写成「药名／用量」，说明也要。" },
    { id: "P65", first: "影楼那份拍摄订单，麻烦把关键字段挑出来。", material: "拍摄订单：客户郝佳，婚纱照11月2日拍；\n服装3套，定金1000，尾款取片时付清。", ask: "请用 50 到 100 个字回答：按「字段名：取值」一行一条，空栏写未填。" },
    { id: "P66", first: "民宿那本入住登记册，我想理成一列字段。", material: "登记册：谭姓住2晚；一家4口要带阳台房；\n有客人只留名和车牌后3位；押金200。", ask: "请用 50 到 100 个字回答：一行一位客人，列出登记到的字段，没写清的写未填。" },
    { id: "P67", first: "苗圃那张采购单我拍了照抄下来，帮我提字段。", material: "采购单：香樟胸径8厘米60株；红叶石楠高50厘米300株；\n草皮卷30块，货到付七成。", ask: "请用 50 到 100 个字回答：一行一项，格式「品名｜规格｜数量」，缺的写未填。" },
    { id: "P68", first: "车站失物登记那几行字，帮我分成字段。", material: "失物登记：黑色双肩包，周一早高峰拾于第二节车厢\n暂存值班室，已联系失主，人未到场", ask: "请用 50 到 100 个字回答：一行一件，写「物品／时间／状态」。" },
    { id: "P69", first: "菜市场这本摊位费流水，帮我按类别数一下。", material: "摊位费流水：蔬菜 4 笔×30 元，水果 3 笔×35 元\n猪肉 5 笔×50 元，水产 2 笔×45 元", ask: "请用 50 到 100 个字回答：一行一类，写「类别／笔数／金额」。" },
    { id: "P70", first: "图书馆还书记录里我标了一堆，帮我数一下。", material: "还书登记：十月八日 3 本，九日 5 本\n十日 2 本，十二日 7 本，逾期 1 本", ask: "请用 50 到 100 个字回答：一行一天，只写日期和逾期本数。" },
    { id: "P71", first: "花园那本种植清单，帮我数数各类有多少。", material: "花坛清单：月季 6 株、绣球 4 株\n薰衣草 10 株成活 7 株，郁金香球 40 个", ask: "请用 50 到 100 个字回答：一行一种，写「花名／株数」。" },
    { id: "P72", first: "驿站那份入库明细，帮我按公司统计件数。", material: "入库明细：通达 40 件，顺风 12 件\n京邦 8 件，极兔 15 件，京东 9 件", ask: "请用 50 到 100 个字回答：一行一家，写「公司／件数」。" },
    { id: "P73", first: "食堂这几天的采购记了几页，帮我算个数。", material: "食堂采购：周一白菜 40 斤、土豆 30 斤\n周二白菜 35 斤、豆腐 15 斤、鸡蛋 25 斤", ask: "请用 50 到 100 个字回答：一行一天，写「日期／斤数」。" },
    { id: "P74", first: "幼儿园点名册那几页，帮我数出勤人数。", material: "点名册：周一实到 24、请假 3\n周二实到 26、请假 1；周三实到 21", ask: "请用 50 到 100 个字回答：一行一天，写「实到／请假」。" },
    { id: "P75", first: "志愿者签到那几张表，帮我统计一下人次。", material: "志愿签到：周六上午 19 人，下午 14 人\n周日上午 22 人，下午 17 人", ask: "请用 50 到 100 个字回答：一行一场，写「场次／人次」。" },
    { id: "P76", first: "洗衣店那本收衣登记，帮我数一下件数。", material: "收衣单：衬衫 3 件，西裤 2 条\n床单 2 条，大衣 1 件，裤子 3 条", ask: "请用 50 到 100 个字回答：一行一类，写「品名／件数」。" },
    { id: "P77", first: "充电桩那页运行记录，帮我数故障次数。", material: "充电桩一号正常，二号上午故障 1 次\n四号下午故障 2 次，五号整晚离线", ask: "请用 50 到 100 个字回答：一行一台，写「桩号／故障次数」。" },
    { id: "P78", first: "陶艺工坊那本窑位记录，帮我数出总数。", material: "窑位记录：素烧杯 8 只、碗 5 只\n釉烧杯 7 只、盘 4 只、小摆件 5 件", ask: "请用 50 到 100 个字回答：一行一批，写「批次／件数」。" },
    { id: "P79", first: "老家院墙那段尺寸单你帮我看看", material: "西厢房外墙 12.5 英尺，门框上沿 6.75 英尺\n后院梯子横档 4.2 英尺", ask: "请用 50 到 100 个字回答：一行一条，写成「名目→米数」。" },
    { id: "P80", first: "楼上鱼缸那套管件尺寸我抄下来了", material: "鱼缸玻璃 0.47 英寸，进水管外径 1.25 英寸\n灯架横臂 11.8 英寸", ask: "请用 50 到 100 个字回答：一行一条，只写厘米数值。" },
    { id: "P81", first: "院里那家拳馆的装备单子你理理", material: "拳馆装备：大沙袋 120 磅，速度球 15 磅\n壶铃 18 磅，地垫 33 磅", ask: "请用 50 到 100 个字回答：一行一条，写成「器材→千克」。" },
    { id: "P82", first: "船厂订帆布的清单搁我桌上了", material: "帆布清单：主帆 38 码，防雨罩 26 码\n舱盖蒙布 5.5 码", ask: "请用 50 到 100 个字回答：一行一条，项目后跟米数。" },
    { id: "P83", first: "山脚那间库房的面积表你看得懂吗", material: "库房面积表：主仓 2450 平方英尺\n副仓 980，装卸平台 620", ask: "请用 50 到 100 个字回答：一行一条，写成「区域→平方米」。" },
    { id: "P84", first: "车队长途那条线的限速牌我记了一路", material: "限速牌：出城 45 迈，弯道 35 迈\n隧道 50 迈，大桥 55 迈", ask: "请用 50 到 100 个字回答：一行一条，单位用米每秒。" },
    { id: "P85", first: "库房那几只储罐的容积表给你", material: "储罐容积：一号 32.5 立方米\n二号 31.9，消防水罐 120 立方米", ask: "请用 50 到 100 个字回答：一行一条，写成「罐体→立方英尺」。" },
    { id: "P86", first: "花园那几瓶营养液的配比你看看", material: "营养液配比：开花肥 2 品脱\n生根粉 3 品脱，除虫乳油 0.4 品脱", ask: "请用 50 到 100 个字回答：一行一条，只写毫升数值。" },
    { id: "P87", first: "田里那几块地的面积我记了个大概", material: "地块面积：东大片 12 亩，西洼地 8.5 亩\n南坡 4.2 亩，秧田 1.6 亩", ask: "请用 50 到 100 个字回答：一行一条，写成「地块→平方米」。" },
    { id: "P88", first: "灯杆那批电表读数你帮我转一下", material: "电表读数：东环路 2140 千瓦时\n公园步道 3020，桥下 640 千瓦时", ask: "请用 50 到 100 个字回答：一行一条，单位用兆焦。" },
    { id: "P89", first: "厨房墙上那张能量表你给看看", material: "能量表：红烧鸡腿 320 千卡\n米饭 230 千卡，紫菜汤 60 千卡", ask: "请用 50 到 100 个字回答：一行一条，写成「菜名→千焦」。" },
    { id: "P90", first: "茶厂那台烘干机的耗热记录在这", material: "烘干机耗热：萎凋槽 24 万英热单位\n初烘 32 万，足烘 41 万英热单位", ask: "请用 50 到 100 个字回答：一行一条，工序后跟千焦数。" },
    { id: "P91", first: "港区拖轮那条日志你帮我换算下", material: "拖轮日志：出海航道 9 节，进港 6 节\n靠泊 3 节，备用待命 11 节", ask: "请用 50 到 100 个字回答：一行一条，单位用公里每小时。" },
    { id: "P92", first: "珠宝店那几颗裸石的重量单给你", material: "裸石重量：主石 1.25 克拉\n配石 6 颗每颗 0.18 克拉，吊坠 2.1 克拉", ask: "请用 50 到 100 个字回答：一行一条，写成「石料→克」。" },
    { id: "P93", first: "柜子里翻出张老地契上面数你认认", material: "老地契：北坡林地 46 英亩\n南坡草场 18.5 英亩，水塘 7.2 英亩", ask: "请用 50 到 100 个字回答：一行一条，写成「地块→公顷」。" },
    { id: "P94", first: "铺子里那卷海图上的航程我抄了一段", material: "海图航程：码头到浮标 3.4 海里\n东礁灯塔 12.6 海里，环岛 33 海里", ask: "请用 50 到 100 个字回答：一行一条，只写航段和公里数。" },
    { id: "P95", first: "桥下那批报修单里的加急件你数数", material: "报修单：1 号伸缩缝加急，2 号护栏加急\n3 号路灯普通，4 号支座垫石加急", ask: "请用 50 到 100 个字回答：一行一条，写「编号／是否加急」。" },
    { id: "P96", first: "账上这页缴费记录你帮我归类统计", material: "缴费记录：物业费 1280 元\n公共电费 316 元、288 元，水管维修 780 元", ask: "请用 50 到 100 个字回答：一行一类，写「项目／笔数／合计」。" },
    { id: "P97", first: "蜂场那本检查记录你帮我统计下", material: "蜂箱检查：1 号新王，3 号缺王\n6 号缺王，8 号老王", ask: "请用 50 到 100 个字回答：一行一类，写「类型／箱数」。" },
    { id: "P98", first: "出苗单上每块的株数我数不清，你帮我合计一下。", material: "出苗单：香樟 1200 株、桂花 860 株\n杜鹃 640 株、女贞 1750 株", ask: "请用 50 到 100 个字回答：一行一种，写「品种／株数」。" },
    { id: "P99", first: "塔吊那几页班次记录我看着头晕", material: "塔吊班次：早班停机 25 分钟\n中班无停机，晚班停机 40 分钟", ask: "请用 50 到 100 个字回答：一行一班，写「班次／原因／时长」。" },
    { id: "P100", first: "锅贴铺那张订货单你帮我算算", material: "锅贴订货：鲜肉 30 份，素三鲜 18 份\n虾仁 12 份，小米粥 40 份", ask: "请用 50 到 100 个字回答：一行一类，写「品类／份数／金额」。" },
  ];

  // localStorage 不可用时的内存兜底（隐私模式/被禁用）：同一次运行内仍然不重复，
  // 但刷新之后会重复 —— 这种情况在 probePoolState().persistent 里如实标成 false。
  let probePoolMemory = { cycle: 1, used: [], usedTotal: 0, last: null, log: [] };
  let probePoolPersistent = true;

  /** 一条探针的完整文本 = 首句 + 空行 + 材料 + 空行 + 短答要求（只按顺序拼接，不生成内容）。 */
  function probePoolText(entry) {
    return entry.first + '\n\n' + entry.material + '\n\n' + entry.ask;
  }

  function probePoolFirstSentence(entry) {
    return String(entry.first || '').trim();
  }

  /** 池指纹：FNV-1a 32 位，逐条按 id/首句/材料/指令折叠，用来标记"这批探针是哪一版"。 */
  function probePoolHash(list) {
    let hash = 0x811c9dc5;
    for (const entry of list) {
      const text = entry.id + '\u0000' + entry.first + '\u0000' + entry.material + '\u0000' + entry.ask + '\u0001';
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
    return 'fnv1a32:' + hash.toString(16).padStart(8, '0');
  }

  function probePoolFind(id) {
    return PROBE_POOL.find((entry) => entry.id === id) || null;
  }

  function probePoolUsedIds(store) {
    // 只认当前池里仍然存在的 id（池被扩充/改写时不认识的记录直接丢弃），并按池内顺序去重。
    const kept = new Set((store.used || []).filter((id) => !!probePoolFind(id)));
    return PROBE_POOL.filter((entry) => kept.has(entry.id)).map((entry) => entry.id);
  }

  function probePoolReadStore() {
    const empty = { cycle: 1, used: [], usedTotal: 0, last: null, log: [] };
    /**
     * 轮换字段归一：cycle 非法 ⇒ 1；usedTotal 缺失（旧记录）⇒ 归一后的"本轮已用"条数。
     * ★ 必须用**归一后**的条数（认得的 id、去重之后），否则旧记录里的重复 id /
     *   不认识的 id 会被重复计数（本卡 DoD 第 5 条）。
     */
    const settle = (store) => {
      const cycle = Number(store.cycle);
      store.cycle = Number.isFinite(cycle) && cycle >= 1 ? Math.floor(cycle) : 1;
      const usedTotal = Number(store.usedTotal);
      store.usedTotal = Number.isFinite(usedTotal) && usedTotal >= 0
        ? Math.floor(usedTotal) : probePoolUsedIds(store).length;
      return store;
    };
    try {
      const raw = localStorage.getItem(PROBE_POOL_STORAGE);
      if (!raw) return empty;
      const parsed = JSON.parse(raw);
      return settle({
        // ★ 0.6.3 轮换：cycle / usedTotal 是新增字段（旧记录里没有）。
        cycle: parsed.cycle,
        used: Array.isArray(parsed.used) ? parsed.used.slice() : [],
        // ★ 持久化兼容：旧记录（probe-pool:v1 只有 used）按"累计 = 本轮已用"解释 ⇒
        //   升级前用掉的 id **不丢失、不重复计数**，在升级后的当前轮里被视为已用
        //   （见 test/run-probe-pool-tests.mjs L 段实测）。
        usedTotal: parsed.usedTotal,
        last: parsed && parsed.last && typeof parsed.last === 'object'
          ? { id: String(parsed.last.id || ''), at: Number(parsed.last.at) || 0 } : null,
        log: Array.isArray(parsed.log) ? parsed.log.slice(-PROBE_POOL_LOG_LIMIT) : [],
      });
    } catch (_) {
      probePoolPersistent = false;
      return settle({
        cycle: probePoolMemory.cycle,
        used: probePoolMemory.used.slice(),
        usedTotal: probePoolMemory.usedTotal,
        last: probePoolMemory.last,
        log: probePoolMemory.log.slice(),
      });
    }
  }

  function probePoolWriteStore(store) {
    const cycle = Number(store.cycle);
    const usedTotal = Number(store.usedTotal);
    const used = (store.used || []).slice();
    probePoolMemory = {
      cycle: Number.isFinite(cycle) && cycle >= 1 ? Math.floor(cycle) : 1,
      used,
      usedTotal: Number.isFinite(usedTotal) && usedTotal >= 0 ? Math.floor(usedTotal) : used.length,
      last: store.last || null,
      log: (store.log || []).slice(-PROBE_POOL_LOG_LIMIT),
    };
    try {
      localStorage.setItem(PROBE_POOL_STORAGE, JSON.stringify({
        version: PROBE_POOL_VERSION,
        poolHash: probePoolHash(PROBE_POOL),
        cycle: probePoolMemory.cycle,
        used: probePoolMemory.used,
        usedTotal: probePoolMemory.usedTotal,
        last: probePoolMemory.last,
        log: probePoolMemory.log,
      }));
      probePoolPersistent = true;
    } catch (_) {
      probePoolPersistent = false;
    }
  }

  function probePoolCrypto() {
    const source = (typeof crypto !== 'undefined' && crypto) ? crypto : null;
    if (source && typeof source.getRandomValues === 'function') return source;
    // 环境没有 crypto.getRandomValues 时**拒绝抽取**，不退化到 Math.random（DoD 要求浏览器本地强随机）。
    throw new Error('探针池需要 crypto.getRandomValues()：当前环境不可用，已拒绝使用弱随机源');
  }

  /** 无偏随机下标：拒绝采样，避免 2^32 不整除 n 时的取模偏置。 */
  function probePoolRandomIndex(size) {
    const n = Number(size) || 0;
    if (n <= 1) return 0;
    const limit = Math.floor(4294967296 / n) * n;
    const buf = new Uint32Array(1);
    const source = probePoolCrypto();
    for (let i = 0; i < 64; i++) {
      source.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
    return buf[0] % n;
  }

  /**
   * 确定性预览：**本轮**第一条还没用过的探针；本轮已抽完时预览下一轮的第一条
   * （下一轮会重洗，这里只给一个确定性的代表，并保证它与上一轮末条不同）。
   */
  function probePoolNext(usedIds, lastId) {
    const used = new Set(usedIds || []);
    const remaining = PROBE_POOL.filter((entry) => !used.has(entry.id));
    if (remaining.length) return remaining[0];
    const fresh = PROBE_POOL.filter((entry) => entry.id !== lastId);
    return fresh[0] || PROBE_POOL[0] || null;
  }

  function probePoolInfo() {
    const store = probePoolReadStore();
    const used = probePoolUsedIds(store);
    const total = PROBE_POOL.length;
    const lastId = store.last ? store.last.id : null;
    const next = probePoolNext(used, lastId);
    const usedTotal = Math.max(Number(store.usedTotal) || 0, used.length);
    return {
      version: PROBE_POOL_VERSION,
      poolHash: probePoolHash(PROBE_POOL),
      total,
      used: used.length,                 // 本轮已用条数（保留旧字段名，语义 == usedInCycle）
      usedInCycle: used.length,          // ★ 0.6.3：本轮已用
      remaining: total - used.length,
      usedTotal,                         // ★ 0.6.3：累计抽取条数（跨轮不清零）
      cycle: Number(store.cycle) || 1,   // ★ 0.6.3：当前第几轮（1-based）
      next: next ? { id: next.id, firstSentence: probePoolFirstSentence(next) } : null,
    };
  }

  /**
   * 抽一条探针并记为已用。
   *   · 一轮内**无放回**（同一轮里不会重复同一句开场语）；
   *   · 一轮用尽 ⇒ **自动进入下一轮**：cycle+1、全池重新洗牌、**新轮首条 ≠ 上一轮末条**；
   *   · 只有池本身为空（部件缺失/被改坏）才返回 null —— 那是异常兜底，不是"用尽"。
   */
  function probePoolDraw() {
    const total = PROBE_POOL.length;
    if (!total) return null;                       // ★ 兜底：池不可用（空池）才是异常
    const store = probePoolReadStore();
    const used = probePoolUsedIds(store);
    const usedSet = new Set(used);
    const previousId = store.last ? store.last.id : null;
    let cycle = Number(store.cycle) || 1;
    let usedTotal = Math.max(Number(store.usedTotal) || 0, used.length);

    let candidates = PROBE_POOL.filter((entry) => !usedSet.has(entry.id));
    if (!candidates.length) {
      // ★ 0.6.3 轮换：本轮抽完 ⇒ 自动开下一轮（重洗 = 从整池重新无放回；跳过上一轮末条）。
      cycle += 1;
      used.length = 0;
      candidates = PROBE_POOL.filter((entry) => entry.id !== previousId);
      // 池里只有 1 条时"新轮首条 ≠ 上轮末条"无解，退回整池（真实池 100 条，走不到这里）。
      if (!candidates.length) candidates = PROBE_POOL.slice();
    }

    const entry = candidates[probePoolRandomIndex(candidates.length)];
    const text = probePoolText(entry);
    const nextUsed = used.concat([entry.id]);
    usedTotal += 1;
    const at = Date.now();
    const record = {
      at,
      id: entry.id,
      firstSentence: probePoolFirstSentence(entry),
      text,
      version: PROBE_POOL_VERSION,
      poolHash: probePoolHash(PROBE_POOL),
      cycle,
      used: nextUsed.length,
      usedTotal,
      remaining: PROBE_POOL.length - nextUsed.length,
    };
    store.cycle = cycle;
    store.used = probePoolUsedIds({ used: nextUsed });   // 落盘前归一成池内顺序：写入确定性、diff 稳定
    store.usedTotal = usedTotal;
    store.last = { id: entry.id, at };
    store.log = (store.log || []).concat([record]).slice(-PROBE_POOL_LOG_LIMIT);
    probePoolWriteStore(store);
    try {
      if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
        console.info('[探针池] 第 ' + cycle + ' 轮 · ' + record.id + ' · ' + record.firstSentence
          + '（本轮 ' + record.used + '/' + PROBE_POOL.length + '，累计 ' + record.usedTotal
          + '，池 ' + record.poolHash + '）');
      }
    } catch (_) {}
    return { id: entry.id, firstSentence: record.firstSentence, text, cycle, usedTotal };
  }

  /** 清空"已用记录"（测试与人工复位用）：回到第 1 轮、累计归零；运行日志保留，供事后追溯。 */
  function probePoolReset() {
    const store = probePoolReadStore();
    store.cycle = 1;
    store.used = [];
    store.usedTotal = 0;
    store.last = null;
    probePoolWriteStore(store);
    return probePoolInfo();
  }

  function probePoolSnapshot() {
    return PROBE_POOL.map((entry) => ({
      id: entry.id,
      firstSentence: probePoolFirstSentence(entry),
      material: entry.material,
      ask: entry.ask,
      text: probePoolText(entry),
    }));
  }

  function probePoolLast() {
    const last = probePoolReadStore().last;
    const entry = last ? probePoolFind(last.id) : null;
    if (!entry) return null;
    return { id: entry.id, firstSentence: probePoolFirstSentence(entry), at: Number(last.at) || 0 };
  }

  function probePoolLog() {
    return probePoolReadStore().log.map((row) => ({ ...row }));
  }

  /** 把 sid / 尝试序号之类的补充信息挂到最新一条运行日志上（卡片 D 用；不改已写内容）。 */
  function probePoolAttach(patch) {
    if (!patch || typeof patch !== 'object') return null;
    const store = probePoolReadStore();
    if (!store.log.length) return null;
    const index = store.log.length - 1;
    store.log[index] = { ...store.log[index], ...patch };
    probePoolWriteStore(store);
    return { ...store.log[index] };
  }

  /**
   * ★ 0.6.3：池"用尽"不再是异常 —— 一轮用完会自动开下一轮。所以这里只在
   * **池本身不可用/为空**时为 true，留给状态机做兜底停止（真正的异常）。
   */
  function probePoolExhausted() {
    return PROBE_POOL.length === 0;
  }

  /** 首句摘要：单行、去多余空白，最多 40 个字符（截断时末位用 … 顶掉第 40 个字符）。 */
  function probePoolSummary(sentence) {
    const text = String(sentence || '').replace(/\s+/g, ' ').trim();
    const chars = [...text];
    if (chars.length <= PROBE_POOL_SUMMARY_MAX) return text;
    return chars.slice(0, PROBE_POOL_SUMMARY_MAX - 1).join('') + '…';
  }

  /** 面板用文案：'探针 P07 · <首句摘要>'（不给 id 时用"本次已抽到的那条"，其次用下一条）。 */
  function probePoolLabel(id) {
    const last = probePoolLast();
    const targetId = id || (last && last.id) || null;
    const entry = targetId ? probePoolFind(targetId)
      : probePoolNext(probePoolUsedIds(probePoolReadStore()), null);
    if (!entry) return '探针池不可用：池内 0 条（不会自动发送探针）';
    return '探针 ' + entry.id + ' · ' + probePoolSummary(entry.first);
  }

  /**
   * ★ 0.6.3 轮换行（逐字口径）：`第 N 轮 / 本轮已用 x / 共 y / 累计 z`
   *   · 本轮刚好抽完时补一句"下一条自动开第 N+1 轮"（**不再**说"耗尽"）；
   *   · 池为空（不可用）时如实标注，不编造数字。
   */
  function probePoolCycleLine() {
    const info = probePoolInfo();
    if (!info.total) return '探针池不可用：池内 0 条';
    const base = '第 ' + info.cycle + ' 轮 / 本轮已用 ' + info.usedInCycle + ' / 共 ' + info.total
      + ' / 累计 ' + info.usedTotal;
    if (info.remaining === 0) return base + '（本轮已抽完，下一条自动开第 ' + (info.cycle + 1) + ' 轮）';
    return base;
  }

  /** 面板整行：池不可用才提示停机；否则给出"本次用了哪条 + 轮换进度"。 */
  function probePoolStatusLine() {
    const info = probePoolInfo();
    const last = probePoolLast();
    if (!info.total) return '探针池不可用：池内 0 条 —— 已暂停新增探针（池部件缺失或被改坏）';
    if (last) return probePoolLabel(last.id) + '（' + probePoolCycleLine() + '，本轮剩 ' + info.remaining + '）';
    return '探针池就绪：下一条 ' + probePoolLabel() + '（' + probePoolCycleLine() + '）';
  }

  /** 面板/日志用的一次性快照（probePoolInfo() 之外的附加字段都放这里，保持对外契约不变）。 */
  function probePoolState() {
    const info = probePoolInfo();
    return {
      ...info,
      exhausted: probePoolExhausted(),
      available: info.total > 0,
      persistent: probePoolPersistent,
      last: probePoolLast(),
      label: probePoolLabel(),
      statusLine: probePoolStatusLine(),
      cycleLine: probePoolCycleLine(),
      storageKey: PROBE_POOL_STORAGE,
      logCount: probePoolLog().length,
    };
  }

  // ── 对外接口挂载 ────────────────────────────────────────────────────────────
  // 60-bootstrap.js 里是 `window.__ARENA_AGENT_BILLING__ = {...}`（整体赋值，且不在本卡
  // 写入范围），所以这里先用 defineProperty 装一个 setter：赋值发生时把 probes/__test__
  // 合并进去。将来若有人在 bootstrap 里直接写了 probes，则以那份为准（这里不覆盖同名键）。
  let probePoolNamespace = null;

  const probePoolApi = {
    info: probePoolInfo,
    draw: probePoolDraw,
    reset: probePoolReset,
    label: probePoolLabel,
    statusLine: probePoolStatusLine,
    cycleLine: probePoolCycleLine,
    state: probePoolState,
    last: probePoolLast,
    log: probePoolLog,
    attach: probePoolAttach,
    snapshot: probePoolSnapshot,
    exhausted: probePoolExhausted,
    version: PROBE_POOL_VERSION,
    poolHash: probePoolHash(PROBE_POOL),
    storageKey: PROBE_POOL_STORAGE,
  };

  const probePoolTestApi = {
    pool: probePoolSnapshot,
    info: probePoolInfo,
    draw: probePoolDraw,
    reset: probePoolReset,
    label: probePoolLabel,
    statusLine: probePoolStatusLine,
    cycleLine: probePoolCycleLine,
    state: probePoolState,
    last: probePoolLast,
    log: probePoolLog,
    attach: probePoolAttach,
    summary: probePoolSummary,
    hash: () => probePoolHash(PROBE_POOL),
    randomIndex: probePoolRandomIndex,
    next: probePoolNext,
    text: (id) => { const entry = probePoolFind(id); return entry ? probePoolText(entry) : null; },
    /** 当前存储里的原始记录（复核持久化兼容用）。 */
    rawStore: () => probePoolReadStore(),
    // 显式表达"刷新"语义：本部件不缓存已用记录（每次都用 localStorage 现读），
    // 所以这里只需要把内存兜底清空，并按存储重新加载。
    reloadFromStorage() {
      probePoolMemory = { cycle: 1, used: [], usedTotal: 0, last: null, log: [] };
      probePoolPersistent = true;
      return probePoolInfo();
    },
    storageKey: PROBE_POOL_STORAGE,
    version: PROBE_POOL_VERSION,
  };

  function probePoolMount(target) {
    if (!target || typeof target !== 'object') return target;
    if (!target.probes) target.probes = probePoolApi;
    else if (target.probes !== probePoolApi) target.probes = { ...probePoolApi, ...target.probes };
    if (!target.__test__ || typeof target.__test__ !== 'object') target.__test__ = {};
    target.__test__.pool = probePoolTestApi;
    return target;
  }

  function probePoolExpose(target) {
    if (!target || typeof target !== 'object') return;
    // 备用入口：不依赖 bootstrap 也能在控制台/离线桩里取到（复核用）。
    try { target.__ARENA_AGENT_BILLING_PROBES__ = probePoolApi; } catch (_) {}
    if (target.__ARENA_AGENT_BILLING__ && typeof target.__ARENA_AGENT_BILLING__ === 'object') {
      probePoolMount(target.__ARENA_AGENT_BILLING__);
      return;
    }
    try {
      Object.defineProperty(target, '__ARENA_AGENT_BILLING__', {
        configurable: true,
        enumerable: true,
        get() { return probePoolNamespace; },
        set(value) { probePoolNamespace = value; probePoolMount(value); },
      });
    } catch (_) { /* 宿主不允许 defineProperty 时静默降级，备用入口仍然可用 */ }
  }

  probePoolExpose(typeof window !== 'undefined' ? window : null);

  // ── 面板接线（临时）────────────────────────────────────────────────────────
  // 40-panel.js 归卡片 B（本卡只读），所以这里**不动它的字节**，只在 renderStatus 外面
  // 包一层，在状态区追加一行探针信息。B/D 把探针信息并进面板之后删掉这一段即可；
  // 状态区里已经出现"探针 "字样时这里不会再追加（避免重复）。
  if (typeof renderStatus === 'function' && !renderStatus.__probePoolWrapped__) {
    const probePoolBaseRenderStatus = renderStatus;
    renderStatus = function probePoolRenderStatus() {
      probePoolBaseRenderStatus.apply(this, arguments);
      try {
        const p = (typeof panel !== 'undefined' && panel) ? panel : null;
        if (!p || !p.status) return;
        const current = String(p.status.textContent || '');
        // 已经有人在面板上显示探针信息（"探针 P07 · …" / "探针：…" / "探针池…"）时不再追加
        if (/探针[：:\s]|探针池/.test(current)) return;
        p.status.textContent = current + '\n' + probePoolStatusLine();
      } catch (_) {}
    };
    renderStatus.__probePoolWrapped__ = true;
  }
  function renderStatus() {
    if (!panel) return;
    const verdict = run.verdict;
    panel.status.textContent = [
      `状态：${run.phase}`,
      run.attempt ? `探针尝试：第 ${run.attempt} 次（轮换 ${run.probeIndex + 1}/${probeList().length}）` : '',
      run.sessionId ? `会话：${run.sessionId}` : '',
      run.completedRounds || run.pendingRound ? `轮数：${run.completedRounds}/${config.rounds}` : '',
      verdict ? `识别：${verdict.label}（${verdict.reason}）` : '',
      verdict?.competitors?.length ? `同价碰撞：${verdict.competitors.join('、')}` : '',
      run.reason ? `原因：${run.reason}` : '',
    ].filter(Boolean).join('\n');
    if (typeof renderPanelV2 === 'function') renderPanelV2();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 候选池面板（卡 B′）—— 池选择 UI + 两个开关 + 诚实展示区
  //
  // 纪律：
  //   · 这一段的**文案**全部集中在 TARGET_POOL_COPY（唯一事实来源，测试按字面断言）；
  //   · renderTargetPoolText()/targetPoolControlsText()/targetPoolHelpText() 是**纯函数**：
  //     只读入参，不碰 DOM、不发请求 ⇒ 无 DOM 的桩里就能拿到面板文本；
  //   · 控件事件只做三件事：改状态（targetPoolApplyControls）→ 就地重判（refreshIdentify，
  //     用**已抓到的原始响应**重算，不重新请求 /cost）→ 重绘。**不归档、不发消息、不取费用**。
  // ═══════════════════════════════════════════════════════════════════════════

  /** 面板文案（**唯一事实来源**；GPT 最终裁定 Q4 的口径，不许出现身份断言式文案）。 */
  const TARGET_POOL_COPY = {
    // ★ 折叠态常驻的一句（装配在 .boundline 里，折叠/展开都在）。GPT 裁定：逐字用这句。
    collapseLine: '费用匹配不确认模型身份；同价的非目标模型也可能保留。',
    // 展开区补的口径（证据规则 / 等待 / 暂停）。★ 这段话在 test/run-target-pool-tests.mjs 里被逐字钉住
    //   （E75c / E85c / 25-panel-static-markup），且它说的是"按证据规则归档 + 待定等待 + 异常暂停"，
    //   与 R1 新口径（无费用证据 ⇒ 暂停）不冲突 ⇒ 卡 I′ 刻意**一字未动**，避免无意义漂移。
    ruleLine: '无兼容目标时，按证据规则自动归档。证据待定时等待，配置异常时暂停。',
    listName: '目标模型名单（只读，固定）',
    listNote: '上列 4 个目标共 7 条 key，名单固定；命中即保留，未命中（有有效费用证据但对不上名单）自动归档，**无费用证据则暂停、不归档**。精确 key 清单、同价碰撞实例与 fixture 见 falsify/evidence/t-mv2j1g19-kkt8dv/。',
    filterFixed: '按候选池固定筛选：恒开（本版不再提供关闭入口）',
    filterFixedNote: '只保留命中目标名单的会话；有证据但未命中时自动归档，无费用证据时暂停并保留。',
    thoughtName: '思考流要求',
    thoughtNote: '按可观测的思考流标记判断，不能证明模型内部是否推理。',
    candidateNote: '≈ 表示价格候选；首项按 key 排序，不表示概率最高。',
    keep: '最终动作：保留',
    archiveMiss: '最终动作：归档｜可验证候选未命中「{名单名称}」',
    archiveNoComplete: '最终动作：归档｜判不出来：无可验证候选',
    // ★ R1（2026-10-11 口径变更）：NO_EVIDENCE 已由 ARCHIVE 改 PAUSE ⇒ 正常路径**走不到**这一条；
    //   保留只为防御（一旦有人把判定表改回去，面板会明确喊出来，而不是静默显示"已归档"）。
    archiveNoEvidence: '（口径异常）最终动作：归档｜判不出来：未取得有效费用证据 —— R1 规定无证据必须暂停、不归档',
    archiveThought: '最终动作：归档｜思考流不符合要求',
    pausedPickPool: '已暂停：目标名单为空（配置异常），请检查内嵌名单',
    pausedInvalidPool: '已暂停：目标名单配置无效（配置异常），请检查内嵌名单',
    // ★ R1：无费用证据 ⇒ 暂停（不归档、不排队新探针、不新建会话）；「无证据」不等于「费用=0」。
    pausedNoEvidence: '已暂停：未取得费用证据（观测缺失，不等于费用=0）——未归档当前会话、未排队新探针、未新建会话；需人工确认',
    waiting: '等待费用结算，尚未作出保留或归档决定',
    waitingThought: '等待思考流标记，尚未作出保留或归档决定',
    archived: '已归档',
    archiveFailed: '归档失败，已暂停',
    renamed: '已改名为：{实际标题}',
    renameFailed: '改名失败；会话处理继续。',
    // 诚实边界：命中只表示**费用证据与名单内候选兼容**，不代表已确认实际模型身份。
    boundary: '命中表示费用证据与名单内候选兼容，不代表已确认实际模型身份。',
    // 同价不可排除是**已知能力限制**（不是 UNKNOWN）：四价完全相同的非目标模型没法可靠排除。
    samePriceLimit: '同价不可排除（已知能力限制）：四价完全相同的非目标模型会一并保留。',
    riskNote: '可能停在 unconstrained，不保证可识别',
    // 多分支价（≥2 个不同取值）：只打标、只说明「以实际费用判定为准」——
    // **不写**「不可识别」：E5 实测里这批 key 在 01a12408 是进了 complete 的。
    multiBranchTag: '多分支价',
    multiBranchNote: '能否命中，以实际费用判定为准。',
  };

  /** 改名 / 归档的**结果**（只有拿到确认才显示；由状态机 D′ 在动作完成后写入，B′ 只展示）。 */
  let targetPoolRenameResult = null;
  let targetPoolArchiveResult = null;

  function setTargetPoolRenameResult(ok, title) {
    targetPoolRenameResult = ok === true ? { ok: true, title: String(title == null ? '' : title) } : { ok: false };
    return targetPoolRenameResult;
  }

  function setTargetPoolArchiveResult(status) {
    targetPoolArchiveResult = status === 'done' || status === 'failed' ? { status } : null;
    return targetPoolArchiveResult;
  }

  function targetPoolPanelShortHash(h) {
    return String(h || '').slice(0, 16) + '…';
  }

  function targetPoolPanelPad(n) {
    return String(n).padStart(2, '0');
  }

  /** 帮助文案（推荐用法；不含任何身份断言）。 */
  function targetPoolHelpText() {
    return [
      '筛选规则：',
      '  · 有思考：立即停止生成并排除当前会话。',
      '  · 无思考：等本轮完整计价，再识别价格候选。',
      '  · 命中目标价格候选时保留；完整证据未命中时归档。',
      '  · 计价暂未到时等待；证据仍不可用时暂停并保留当前会话。',
      '  · 同价模型无法区分，模型名称仅表示价格候选。',
    ].join('\n');
  }

  /** 固定筛选机制文案；兼容调用参数保留。 */
  function targetPoolControlsText(state) {
    return [
      TARGET_POOL_COPY.collapseLine,
      '筛选机制（固定）：',
      '有思考：立即停止生成并排除当前会话。',
      '无思考：等本轮完整计价，再识别价格候选。',
      '计价尚未就绪时等待；证据仍不可用时暂停并保留。',
    ].join('\n');
  }

  /** 判定区文案（纯函数）：最终动作 + reason + 计数 + 限制 + 固定标注。 */
  function targetPoolVerdictText(view) {
    const v = view || {};
    const j = v.judgement || null;
    const L = [];
    if (!j) {
      L.push(TARGET_POOL_COPY.waiting);
      L.push(TARGET_POOL_COPY.boundary);
      return L.join('\n');
    }
    const C = Number(j.completeCount) || 0;
    const H = Array.isArray(j.matchedKeys) ? j.matchedKeys.length : 0;
    const U = Number(j.unconstrainedCount) || 0;
    const lc = Number(j.longContextMessages) || 0;
    const poolName = v.poolTitle || '（未命名名单）';
    L.push('判定：' + j.reason + '（decision=' + j.decision + '，action=' + j.action + '）');

    if (j.action === 'ARCHIVE') {
      if (j.reason === 'POOL_MISS') {
        L.push(TARGET_POOL_COPY.archiveMiss.replace('{名单名称}', poolName));
      } else if (j.reason.startsWith('NO_COMPLETE')) {
        L.push(TARGET_POOL_COPY.archiveNoComplete);
      } else if (j.reason.startsWith('NO_EVIDENCE')) {
        L.push(TARGET_POOL_COPY.archiveNoEvidence);
      } else if (j.reason.startsWith('THOUGHT_MISMATCH')) {
        L.push(TARGET_POOL_COPY.archiveThought);
      } else {
        L.push('最终动作：归档｜' + (j.message || j.reason));
      }
    } else if (j.action === 'PAUSE') {
      // ★ R1：NO_EVIDENCE（无费用证据）与 POOL_INVALID/POOL_EMPTY（配置异常）**不能混说**。
      if (j.reason === 'POOL_INVALID') L.push(TARGET_POOL_COPY.pausedInvalidPool);
      else if (j.reason === 'NO_EVIDENCE') L.push(TARGET_POOL_COPY.pausedNoEvidence);
      else L.push(TARGET_POOL_COPY.pausedPickPool);
    } else if (j.action === 'WAIT') {
      L.push(j.reason === 'THOUGHT_UNKNOWN' ? TARGET_POOL_COPY.waitingThought : TARGET_POOL_COPY.waiting);
    } else {
      // 固定筛选恒开 ⇒ 只有命中才走到这里（保留）。
      L.push(TARGET_POOL_COPY.keep);
      if (H > 0) L.push('✅ 目标费用兼容：' + j.matchedNames.join('、') + '（共 ' + H + ' 条）');
    }

    if (H > 0) {
      L.push('可验证候选共 ' + C + ' 条：名单内 ' + H + ' 条，名单外 ' + (C - H) + ' 条；按当前规则保留。');
    } else if (C > 0) {
      L.push('可验证候选共 ' + C + ' 条：名单内 0 条，名单外 ' + C + ' 条。');
    }
    if (U > 0) L.push('另有 ' + U + ' 条约束不足候选，仅展示，不计入命中。');
    if (lc > 0) L.push('⚠ 判定受限：已排除 ' + lc + ' 条长上下文记录；结果基于其余记录。');
    L.push('计数：complete=' + C + ' ｜ unconstrained=' + U + ' ｜ ignored=' + (Number(j.ignoredCount) || 0)
      + '（目录无 in/out 价的行）');
    L.push('命中 key（' + H + ' 条，命中表示费用兼容、不是身份确认）：');
    if (!H) L.push('  （无）');
    const outOfPool = Array.isArray(j.completeKeysOutOfPool) ? j.completeKeysOutOfPool : [];
    for (const k of (j.matchedKeys || []).slice(0, 12)) L.push('  · ' + k);
    if (outOfPool.length) {
      L.push('名单外可验证候选（前 ' + Math.min(12, outOfPool.length) + ' / 共 ' + outOfPool.length + '）：');
      for (const k of outOfPool.slice(0, 12)) L.push('  · ' + k);
    }
    L.push('固定标注：' + TARGET_POOL_COPY.boundary);
    L.push('固定标注：' + TARGET_POOL_COPY.samePriceLimit);
    return L.join('\n');
  }

  /**
   * 只读「目标模型名单」区文本（纯函数）：4 个模型展示名 + 7 条 key + 多分支价标注
   * + 同价不可排除的实例 + 归档口径。**没有任何勾选入口**。
   */
  function renderTargetPoolTargetsText(view) {
    const v = view || {};
    const models = (Array.isArray(v.models) && v.models.length) ? v.models : TARGET_POOL_MODELS;
    const groups = Array.isArray(v.priceGroups) ? v.priceGroups : [];
    const L = [];
    L.push(TARGET_POOL_COPY.listName + '（' + (Number(v.poolCount) || 0) + ' 条 key）');
    for (const m of models) {
      L.push('· ' + m.label + (m.multiBranch ? '（' + TARGET_POOL_COPY.multiBranchTag + '）' : ''));
      for (const k of (m.keys || [])) L.push('    ' + k);
    }
    L.push(TARGET_POOL_COPY.listNote);
    // 同价不可排除：只列"名单内 + 名单外同价"的组，作为**已知能力限制**如实展示。
    const collisions = groups.filter((g) => Array.isArray(g.outOfPool) && g.outOfPool.length);
    for (const g of collisions) {
      L.push('⚠ 同价不可区分（向量 ' + g.vectorKey + '）：名单内 ' + g.inPool.join('、')
        + ' ｜ 名单外同价 ' + g.outOfPool.join('、') + ' ⇒ 该组会一并保留，无法只留名单内的那条。');
    }
    if (collisions.length) L.push(TARGET_POOL_COPY.samePriceLimit);
    L.push(TARGET_POOL_COPY.ruleLine);
    return L.join('\n');
  }

  /** 完整面板文本（纯函数）—— 无 DOM 也能拿到，便于复核。 */
  function renderTargetPoolText(view) {
    const v = view || {};
    const cat = v.catalog || TARGET_POOL_CATALOG;
    const j = v.judgement || null;
    const runHash = v.runningCatalogHash || null;
    const controls = { filterEnabled: TARGET_POOL_FIXED_FILTER, thoughtRequirement: v.thoughtRequirement };
    const plan = (j && j.plan) || targetPoolRejudgePlan({ hasValidReport: false, poolCatalogHash: cat.sha256, runningCatalogHash: runHash });
    const sameHash = !!runHash && runHash === cat.sha256;
    const L = [];
    L.push('【目标模型名单】' + (v.poolTitle || '（未命名名单）') + '（' + (Number(v.poolCount) || 0) + ' 条 key）');
    L.push('目录版本：' + cat.source);
    L.push('  名单快照 sha256=' + targetPoolPanelShortHash(cat.sha256) + '  运行目录 sha256=' + (runHash ? targetPoolPanelShortHash(runHash) : '（未知）'));
    L.push(sameHash ? '  ✓ ' + plan.message : '  ⚠ ' + plan.message);
    // ★ 名单来源恒定（本版没有预设多选 / 行级勾选入口）。
    L.push('名单来源：固定名单 ' + (v.targetId || TARGET_POOL_TARGET_ID) + '（只读，不可选）');
    if (v.legacyNotice) L.push('  ⚠ ' + v.legacyNotice);
    L.push('目录行：共 ' + cat.rows + ' 行 = 有价 ' + cat.pricedRows + ' + 无价 ' + cat.unpricedRows
      + '；四价齐全（四个价字段都非 null，仅统计）' + cat.completePricedRows
      + '（其中四项单值 ' + cat.singleValuedRows + '、多分支价 ' + cat.multiValuedRows + '）');
    const presetList = (Array.isArray(v.presets) && v.presets.length) ? v.presets : TARGET_POOL_PRESETS;
    L.push('名单说明：' + presetList.map((p) => p.title + '＝' + (p.note || '—')).join(' ｜ '));
    // ★ 名单明细（4 个模型展示名 + 7 条 key + 多分支打标 + 同价不可排除实例）——与页面上
    //   .pooltargetssay 展示的是同一份文本；放进全文里，证据文件本身就能逐条核对。
    L.push(renderTargetPoolTargetsText(v));
    L.push(TARGET_POOL_COPY.multiBranchTag + '：' + TARGET_POOL_COPY.multiBranchNote
      + '（目录里共 ' + Object.keys(TARGET_POOL_MULTI_BRANCH).length + ' 条多分支价行；名单里的多分支价行同样能进 complete，实测见证据目录）');
    const risks = Array.isArray(v.risks) ? v.risks : [];
    L.push('风险标注：名单里 ' + risks.length + ' 条 key ' + TARGET_POOL_COPY.riskNote);
    for (const r of risks.slice(0, 8)) L.push('  ⚠ ' + r.key + '：' + r.reason);
    if (risks.length > 8) L.push('  …另有 ' + (risks.length - 8) + ' 条');
    L.push('');
    L.push(targetPoolControlsText(controls));
    L.push('');
    L.push(TARGET_POOL_COPY.candidateNote);
    L.push('');
    L.push(targetPoolVerdictText(v));
    if (v.rename && v.rename.ok === true) L.push(TARGET_POOL_COPY.renamed.replace('{实际标题}', v.rename.title));
    else if (v.rename && v.rename.ok === false) L.push(TARGET_POOL_COPY.renameFailed);
    if (v.archive && v.archive.status === 'done') L.push(TARGET_POOL_COPY.archived);
    else if (v.archive && v.archive.status === 'failed') L.push(TARGET_POOL_COPY.archiveFailed);
    L.push('');
    L.push(targetPoolHelpText());
    return L.join('\n');
  }

  /** 当前会话的 report（45-identify 维护；没有就返回 null —— 不抛、不请求）。 */
  function targetPoolCurrentReport() {
    try {
      if (typeof identifyView === 'undefined' || !identifyView) return null;
      const sid = typeof currentSessionId === 'function' ? currentSessionId() : run.sessionId;
      if (sid && (!identifyView.source || identifyView.source.sid !== sid)) return null;
      return identifyView.report || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 折叠态徽标文案：名单条数（**恒定 7**）。★ 唯一事实来源 —— 静态标记里的占位文字与
   * renderPanelV2 的动态刷新都用这个函数，避免"静态写 7、动态写成别的"两处不一致。
   */
  function targetPoolCountBadgeText() {
    let n = 0;
    try { n = targetPoolEffectiveKeys().length; } catch (_) { n = 0; }
    return n ? n + ' 条 key（固定）' : '';
  }

  /** 重绘整个目标名单区（文本 + 只读名单 + 命中列表 + 唯一偏好的控件状态）。 */
  function renderTargetPool() {
    if (!panel || !panel.pool) return;
    if (panel.poolthought) panel.poolthought.value = targetPoolState.thoughtRequirement;
    const sid = typeof currentSessionId === 'function' ? currentSessionId() : run.sessionId;
    const currentSession = run.sessionId && run.sessionId === sid;
    const currentRound = currentSession && run.rounds && typeof run.rounds === 'object';
    if ((currentRound && (!run.rounds.outputComplete || !run.rounds.billingReady)) || (currentSession && run.thinking && run.thinking.state === 'SEEN')) {
      const model = panelV2ModelView();
      panel.pool.textContent = [model.stage, targetPoolControlsText(), TARGET_POOL_COPY.boundary].join('\n');
      if (panel.pooltargets) panel.pooltargets.textContent = renderTargetPoolTargetsText(targetPoolView(null, { judgement: null }));
      if (panel.targetcount) panel.targetcount.textContent = targetPoolCountBadgeText();
      if (panel.poolhitlist) panel.poolhitlist.textContent = model.tone === 'excluded' ? '（已因思考排除，未按价格判定）' : '（尚未判定）';
      if (panel.poolhits) {
        panel.poolhits.open = false;
        const summary = panel.poolhits.querySelector('summary');
        if (summary) summary.textContent = model.tone === 'excluded' ? '价格候选判定已跳过' : '命中的候选 key（尚未判定）';
      }
      return;
    }
    const report = targetPoolCurrentReport();
    const judgement = report ? targetPoolJudgement(report, {}) : null;
    if (judgement) {
      const pool = new Set(judgement.poolKeys);
      judgement.completeKeysOutOfPool = (Array.isArray(report.complete) ? report.complete : [])
        .map((row) => (row && typeof row === 'object' ? row.key : null))
        .filter((k) => typeof k === 'string' && k && !pool.has(k));
    }
    const view = targetPoolView(report, { judgement, rename: targetPoolRenameResult, archive: targetPoolArchiveResult });
    // 同价不可区分（已知能力限制）：用内嵌目录现算"名单内 + 名单外同价"的组，面板如实展示。
    try { view.priceGroups = targetPoolPriceGroups(view.poolKeys); } catch (_) { view.priceGroups = []; }
    panel.pool.textContent = renderTargetPoolText(view);
    if (panel.pooltargets) panel.pooltargets.textContent = renderTargetPoolTargetsText(view);
    if (panel.targetcount) panel.targetcount.textContent = targetPoolCountBadgeText();
    const hits = judgement && Array.isArray(judgement.matchedKeys) ? judgement.matchedKeys : [];
    if (panel.poolhitlist) {
      panel.poolhitlist.textContent = hits.length
        ? hits.map((k) => k + ' — ' + targetPoolKeyLabel(k)).join('\n')
        : '（本次没有命中名单内候选）';
    }
    if (panel.poolhits) {
      panel.poolhits.open = hits.length > 0;
      const summary = panel.poolhits.querySelector('summary');
      if (summary) summary.textContent = '命中的候选 key（' + hits.length + ' 条，可展开）';
    }
  }

  /**
   * 控件接线（**唯一**挂事件的地方）。这些处理器只：
   *   ① targetPoolApplyControls（改状态 + 落本地记忆，effects 恒为空）
   *   ② refreshIdentify（用已抓到的原始响应**就地重判**；目录版本变了就由面板文案提示用留存 cost JSON 重跑内核）
   *   ③ renderTargetPool（重绘）
   * 绝不归档、绝不发消息、绝不重新请求 /cost（回归测试按源码断言 + 行为断言双重把关）。
   * ★ 本版只剩思考流三态一个控件；**删掉的是控件，不是重判链路** ——
   *   onchange 里的 refreshIdentify 必须保留（去掉它 = 换偏好后不重判，GPT 最终裁定第 4 条）。
   */
  function wireTargetPoolControls() {
    if (!panel) return false;
    if (panel.poolthought) {
      panel.poolthought.onchange = () => {
        targetPoolApplyControls({ thoughtRequirement: panel.poolthought.value });
        void refreshIdentify();
        renderTargetPool();
      };
    }
    return true;
  }

  function createPanel() {
    const host = document.createElement('div');
    host.id = '__arena_agent_billing_panel__';
    host.innerHTML = `<style>
      #__arena_agent_billing_panel__{position:fixed;right:16px;top:76px;z-index:2147483646;font:13px system-ui;color:#111827}
      #__arena_agent_billing_panel__ .box{width:310px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 30px #0003;padding:12px}
      #__arena_agent_billing_panel__ .head{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px}
      #__arena_agent_billing_panel__ label{display:block;margin:7px 0 3px;color:#475569}
      #__arena_agent_billing_panel__ input,#__arena_agent_billing_panel__ textarea{box-sizing:border-box;width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:6px;font:inherit}
      #__arena_agent_billing_panel__ textarea{min-height:58px;resize:vertical}
      #__arena_agent_billing_panel__ button{border:0;border-radius:6px;padding:7px 9px;margin:8px 4px 0 0;cursor:pointer;background:#2563eb;color:#fff}
      #__arena_agent_billing_panel__ button.stop{background:#dc2626}
      #__arena_agent_billing_panel__ button.fold{background:#64748b;padding:3px 7px;margin:0}
      #__arena_agent_billing_panel__ pre{white-space:pre-wrap;max-height:130px;overflow:auto;background:#f8fafc;border-radius:6px;padding:7px;margin:9px 0 0;font-size:11px}
      #__arena_agent_billing_panel__ .costbox{margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:8px}
      #__arena_agent_billing_panel__ .costhead{display:flex;justify-content:space-between;align-items:center;font-weight:700;color:#0f172a;margin-bottom:4px}
      #__arena_agent_billing_panel__ pre.cost{max-height:190px;background:#f1f5f9;margin:0}
      #__arena_agent_billing_panel__ button.refresh{background:#0f766e;padding:4px 8px;margin:0;font-size:12px}
      #__arena_agent_billing_panel__ button.restore{background:#b45309;padding:4px 8px;margin:6px 0 0;font-size:12px}
      #__arena_agent_billing_panel__ .identbox{margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:8px}
      #__arena_agent_billing_panel__ pre.identify{max-height:300px;background:#f8fafc;margin:0}
      #__arena_agent_billing_panel__ button.identrefresh{background:#0f766e;padding:4px 8px;margin:0;font-size:12px}
      #__arena_agent_billing_panel__ button.export{background:#7c3aed;padding:4px 8px;margin:0 0 0 4px;font-size:12px}
      #__arena_agent_billing_panel__ button.export:disabled{background:#94a3b8;cursor:not-allowed}
      #__arena_agent_billing_panel__ .poolbox{margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:8px}
      #__arena_agent_billing_panel__ select{box-sizing:border-box;width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:5px;font:inherit}
      #__arena_agent_billing_panel__ pre.pooltargetssay{max-height:220px;background:#ecfdf5;margin:4px 0 0;font-size:11px;color:#065f46;white-space:pre-wrap}
      #__arena_agent_billing_panel__ pre.pooltargetssay{max-height:220px;background:#ecfdf5;margin:4px 0 0;font-size:11px;color:#065f46;white-space:pre-wrap}
      #__arena_agent_billing_panel__ .targetcount{color:#64748b;font-size:11px;font-weight:400}
      #__arena_agent_billing_panel__ pre.poolmultisay{max-height:none;background:#fef9c3;margin:4px 0 0;font-size:11px;color:#713f12}
      #__arena_agent_billing_panel__ pre.poolthoughtsay{max-height:none;background:#eef2ff;margin:4px 0 0;font-size:11px;color:#3730a3}
      #__arena_agent_billing_panel__ p.boundline{margin:4px 0 0;color:#475569;font-size:11px;line-height:1.45}
      #__arena_agent_billing_panel__ pre.pool{max-height:340px;background:#f8fafc;margin:9px 0 0}
      #__arena_agent_billing_panel__ details.poolhits{margin-top:6px;font-size:12px;color:#334155}
      #__arena_agent_billing_panel__ details.poolhits pre{max-height:180px;margin-top:4px}
    </style><div class="box"><div class="head"><span>Arena Agent 计费筛选</span><button class="fold">—</button></div><div class="body">
      <label>目标候选</label><select class="target"><option value="opus">Claude Opus（任一价格档）</option><option value="opus5.5">Claude Opus 5.5</option><option value="opus5">Claude Opus 5</option></select>
      <label>轮换探针（每行一条，命中前循环）</label><textarea class="probe"></textarea>
      <label class="probenotecopy">探针池：100 条素材，轮内无放回；一轮用尽自动进入下一轮（旧「命中前循环」口径已废弃）</label>
      <label>目标命中后的任务轮数</label><input class="rounds" type="number" min="0" max="20" />
      <label>任务提示词（每行一轮，循环使用）</label><textarea class="tasks"></textarea>
      <button class="start">开始新 Agent 筛选</button><button class="stop">停止</button>
      <pre class="status"></pre>
      <div class="kv"><label class="probecyclelabel">探针轮次：—</label></div>
      <div class="costbox">
        <div class="costhead"><span>当前会话费用（只读）</span><button class="refresh">刷新</button></div>
        <pre class="cost">费用读数：准备中…</pre>
        <button class="restore" hidden>覆盖开关没生效，点这里恢复</button>
      </div>
      <div class="identbox">
        <div class="costhead"><span>当前会话模型候选（内嵌内核）</span><span><button class="identrefresh">刷新</button><button class="export" disabled>导出当前会话账单 JSON</button></span></div>
        <pre class="identify">识别：准备中…</pre>
      </div>
      <div class="poolbox">
        <div class="costhead"><span>目标模型名单（固定；命中即保留，未命中自动归档，无费用证据则暂停不归档）<span class="targetcount">7 条 key（固定）</span></span></div>
        <label>目标模型名单（只读，固定）</label>
        <pre class="pooltargetssay">名单：准备中…</pre>
        <label>思考流要求：不管 / 要 / 不要</label>
        <select class="poolthought"><option value="any">不管（默认）</option><option value="require">要</option><option value="avoid">不要</option></select>
        <pre class="poolthoughtsay">按可观测的思考流标记判断，不能证明模型内部是否推理。</pre>
        <pre class="poolmultisay">多分支价：能否命中，以实际费用判定为准。</pre>
        <pre class="pool">名单判定：准备中…</pre>
        <details class="poolhits"><summary>命中的候选 key（0 条，可展开）</summary><pre class="poolhitlist">（尚未判定）</pre></details>
        <p class="boundline">${TARGET_POOL_COPY.collapseLine}</p>
      </div>
    </div></div>`;
    document.documentElement.appendChild(host);
      panel = {
      host,
      body: host.querySelector('.body'),
      status: host.querySelector('.status'),
      probe: host.querySelector('.probe'),
      rounds: host.querySelector('.rounds'),
      tasks: host.querySelector('.tasks'),
      target: host.querySelector('.target'),
      cost: host.querySelector('.cost'),
      refresh: host.querySelector('.refresh'),
      restore: host.querySelector('.restore'),
      identify: host.querySelector('.identify'),
      identrefresh: host.querySelector('.identrefresh'),
      export: host.querySelector('.export'),
      poolthought: host.querySelector('.poolthought'),
      poolthoughtsay: host.querySelector('.poolthoughtsay'),
      pooltargets: host.querySelector('.pooltargetssay'),
      targetcount: host.querySelector('.targetcount'),
      poolmultisay: host.querySelector('.poolmultisay'),
      pool: host.querySelector('.pool'),
      poolhits: host.querySelector('.poolhits'),
      poolhitlist: host.querySelector('.poolhitlist'),
      probecyclelabel: host.querySelector('.probecyclelabel'),
    };
    panel.probe.value = config.probeText;
    panel.target.value = config.target;
    panel.rounds.value = config.rounds;
    panel.tasks.value = config.tasks;
    host.querySelector('.fold').onclick = () => { panel.body.hidden = !panel.body.hidden; };
    panel.probe.onchange = () => { config.probeText = panel.probe.value; save(); };
    panel.target.onchange = () => { config.target = panel.target.value; save(); };
    panel.rounds.onchange = () => { config.rounds = Math.max(0, Math.min(20, Math.floor(Number(panel.rounds.value) || 0))); panel.rounds.value = config.rounds; save(); };
    panel.tasks.onchange = () => { config.tasks = panel.tasks.value || DEFAULT_TASK; save(); };
    host.querySelector('.start').onclick = () => void startAutomation();
    host.querySelector('.stop').onclick = stopAutomation;
    renderStatus();
    panel.refresh.onclick = () => void refreshCost(true);
    panel.restore.onclick = () => { enableBillingFlag(); void refreshCost(true); };
    panel.identrefresh.onclick = () => { refreshIdentify(); if (!identifyView.source) notify('尚未抓到当前会话的 /cost 响应，稍后自动重试'); };
    panel.export.onclick = exportSessionCost;
    wireTargetPoolControls();
    renderCost();
    renderIdentify();
    renderTargetPool();
    if (panel.poolthought) panel.poolthought.value = targetPoolState.thoughtRequirement;
    // ★ 卡 G（t-mv27v7z9-d5lk7i）：插入式面板改版 —— 不改上面任何一行（B′ 的复核基线仍成立）。
    applyPanelV2();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 卡 G（t-mv27v7z9-d5lk7i）· 面板改版（**插入式**，上面原有行一行未改）
  //
  // 目标（用户新要求 + 清单 15–21）：
  //   · 独立浮层：position:fixed + 高 z-index ⇒ 不占文档流、不撑高侧栏；
  //   · 总高受限：展开态 max-height = min(70vh, 640px)，内部详情区 overflow:auto；
  //   · 默认折叠：折叠态只有一行摘要（判定 / 当前池 / 两个开关 / 剩余探针）≤ 56px，
  //     点标题栏展开收起；折叠态与位置写入 localStorage，跨刷新恢复；
  //   · 候选清单默认只显前 5 条 + 「展开全部（共 N 条）」，长文本省略号、键值不换行；
  //   · 极简美化：11–12px 字号 / 统一行高圆角间距 / 低饱和配色 / 分区细分隔线；
  //     颜色全走 CSS 变量 + prefers-color-scheme 暗色适配（不硬编码白底黑字）；
  //   · 上限输入：留空 = 不限（写 null）、非法输入（0 / 负数 / 非数字）不改状态并提示。
  //
  // 纪律（复核可断言）：纯函数文本路径（renderTargetPoolText / targetPoolControlsText /
  //   targetPoolVerdictText / targetPoolHelpText）**一字未动**；两个开关仍只改状态 + 就地重判
  //   （零归档、零发送、零 /cost 重取）；这一块只读 run/config（不写 run）。
  // ═══════════════════════════════════════════════════════════════════════════

  const PANEL_V2_KEY = 'arena-agent-billing:panel:v1';
  const PANEL_V2_COPY = {
    title: 'Arena 计费筛选',
    limitHint: '留空 = 不限；只有填正数才会在到线时停止。',
    limitInvalid: '上限必须是正数；留空 = 不限，本次输入已忽略',
    candidates: '本轮可验证候选',
    history: '历史候选（仅供参考）',
    viewAll: '查看全部候选',
    collapseCands: '收起候选',
    noCandidates: '（本会话还没有可验证候选）',
    noHistory: '本次没有可用的历史报告（新号 /api/history/unified 为空时属正常）；历史处理不发消息、不改名、不归档。',
    foldOpen: '▾',
    foldClose: '▸',
    stateIdle: '待开始',
    targets: '目标模型名单（固定）',
    judge: '判定详情与命名依据',
    config: '探针 / 任务 / 轮数 / 目标 配置',
    diag: '费用读数 / 识别详情 / 诊断',
  };

  let panelV2State = { collapsed: true, x: null, y: null };
  let panelV2Notice = null;
  let panelV2Expanded = false;
  let panelV2Drag = null;

  const PANEL_V2_MARKUP = `<style>
      #__arena_agent_billing_panel__{position:fixed;right:14px;top:72px;z-index:2147482000;color-scheme:light dark;
        --ab-fg:#1f2937;--ab-dim:#5b6675;--ab-bg:#ffffff;--ab-bg2:#f6f8fa;--ab-line:#e2e6eb;--ab-accent:#3b6fd4;
        --ab-bad:#b3261e;--ab-warn:#8a5a00;--ab-ok:#0b6b4f;
        font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ab-fg)}
      @media (prefers-color-scheme: dark){#__arena_agent_billing_panel__{
        --ab-fg:#e6e8eb;--ab-dim:#9aa3ad;--ab-bg:#171a1d;--ab-bg2:#1f2429;--ab-line:#333a41;--ab-accent:#8ab4f8;
        --ab-bad:#f2b8b5;--ab-warn:#f5d38a;--ab-ok:#7fd1b0}}
      #__arena_agent_billing_panel__ *{box-sizing:border-box}
      #__arena_agent_billing_panel__ .box{width:340px;max-width:calc(100vw - 28px);max-height:min(70vh,640px);
        display:flex;flex-direction:column;background:var(--ab-bg);border:1px solid var(--ab-line);border-radius:10px;
        box-shadow:0 6px 22px rgba(0,0,0,.28);overflow:hidden}
      #__arena_agent_billing_panel__ .head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:5px 8px;
        background:var(--ab-bg2);border-bottom:1px solid var(--ab-line);cursor:move;-webkit-user-select:none;user-select:none}
      #__arena_agent_billing_panel__ .head .title{font-weight:600;font-size:12px;white-space:nowrap}
      #__arena_agent_billing_panel__ .head .state{flex:0 0 auto;font-size:11px;font-weight:600;padding:1px 5px;border-left:3px solid var(--ab-line);white-space:nowrap}
      #__arena_agent_billing_panel__ .heads{padding:4px 10px;font-size:11px;color:var(--ab-dim);background:var(--ab-bg2);overflow-wrap:anywhere;border-bottom:1px solid var(--ab-line)}
      #__arena_agent_billing_panel__ .head .acts{margin-left:auto;flex:0 0 auto;display:flex;gap:4px}
      #__arena_agent_billing_panel__ .head .acts button{margin:0;padding:2px 7px;font-size:11px}
      #__arena_agent_billing_panel__ .head .fold{flex:0 0 auto;border:0;border-radius:6px;background:transparent;color:var(--ab-fg);font-size:12px;line-height:1;padding:3px 6px;margin:0;cursor:pointer}
      #__arena_agent_billing_panel__ .body{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 10px 8px}
      /* ★ 折叠态常驻的诚实边界（GPT 冻结文案）：放在 .head 与 .body 之间 ⇒ body 被 hidden 时它仍在屏上。
         单行 11px、行高 1.3 ⇒ 折叠态总高 ≈ 28(head) + 15 ≈ 43px，仍在 ≤56px 预算内。 */
      #__arena_agent_billing_panel__ p.boundline{margin:0;padding:2px 8px 3px;font-size:11px;line-height:1.3;
        color:var(--ab-dim);background:var(--ab-bg2);border-bottom:1px solid var(--ab-line)}
      #__arena_agent_billing_panel__ .sec{border-top:1px solid var(--ab-line);padding:7px 0 3px}
      #__arena_agent_billing_panel__ .sec:first-child{border-top:0}
      #__arena_agent_billing_panel__ .row{display:flex;gap:6px;align-items:baseline;font-size:12px;font-weight:600}
      #__arena_agent_billing_panel__ .row .k{flex:0 0 auto}
      #__arena_agent_billing_panel__ .row .v{flex:1 1 auto;min-width:0;font-weight:400;color:var(--ab-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
      #__arena_agent_billing_panel__ .kv{display:flex;gap:6px;align-items:center;margin:3px 0}
      #__arena_agent_billing_panel__ .kv label{flex:0 0 auto;margin:0;font-size:12px;color:var(--ab-fg)}
      #__arena_agent_billing_panel__ .kv input{flex:1 1 auto;min-width:0}
      #__arena_agent_billing_panel__ label{display:block;margin:6px 0 3px;font-size:12px;color:var(--ab-dim)}
      #__arena_agent_billing_panel__ input,#__arena_agent_billing_panel__ textarea,#__arena_agent_billing_panel__ select{box-sizing:border-box;width:100%;border:1px solid var(--ab-line);border-radius:6px;padding:4px 6px;font:inherit;background:var(--ab-bg);color:var(--ab-fg)}
      #__arena_agent_billing_panel__ textarea{min-height:52px;resize:vertical}
      #__arena_agent_billing_panel__ button{border:0;border-radius:6px;padding:5px 8px;margin:6px 4px 0 0;cursor:pointer;background:var(--ab-accent);color:#fff;font-size:12px}
      #__arena_agent_billing_panel__ button.stop{background:#b3261e}
      #__arena_agent_billing_panel__ button.resume{background:#0b6b4f}
      #__arena_agent_billing_panel__ button.candmore{background:transparent;color:var(--ab-accent);border:1px solid var(--ab-line);padding:3px 6px;margin-top:4px;font-size:11px}
      #__arena_agent_billing_panel__ pre{white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;background:var(--ab-bg2);border-radius:6px;padding:5px 6px;margin:6px 0 0;font-size:11px;line-height:1.5}
      #__arena_agent_billing_panel__ .hint{font-size:11px;color:var(--ab-dim);margin-top:4px}
      #__arena_agent_billing_panel__ details{margin:5px 0 0;font-size:11px;color:var(--ab-dim)}
      #__arena_agent_billing_panel__ summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--ab-fg);padding:2px 0}
      #__arena_agent_billing_panel__ .costbox,#__arena_agent_billing_panel__ .identbox,#__arena_agent_billing_panel__ .poolbox{margin-top:8px;border-top:1px dashed var(--ab-line);padding-top:6px}
      #__arena_agent_billing_panel__ .costhead{display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:600;font-size:12px;margin-bottom:4px}
      #__arena_agent_billing_panel__ pre.cost{max-height:150px;margin:0}
      #__arena_agent_billing_panel__ button.refresh{background:#0b6b4f;padding:3px 7px;margin:0;font-size:11px}
      #__arena_agent_billing_panel__ button.restore{background:#8a5a00;padding:3px 7px;margin:5px 0 0;font-size:11px}
      #__arena_agent_billing_panel__ pre.identify{max-height:180px;margin:0}
      #__arena_agent_billing_panel__ button.identrefresh{background:#0b6b4f;padding:3px 7px;margin:0;font-size:11px}
      #__arena_agent_billing_panel__ button.export{background:#6b4bb8;padding:3px 7px;margin:0 0 0 4px;font-size:11px}
      #__arena_agent_billing_panel__ button.export:disabled{background:#9aa3ad;cursor:not-allowed}
      #__arena_agent_billing_panel__ pre.poolmultisay,#__arena_agent_billing_panel__ pre.poolthoughtsay,#__arena_agent_billing_panel__ pre.pooltargetssay{max-height:none;font-size:11px;margin:4px 0 0}
      #__arena_agent_billing_panel__ pre.pooltargetssay{max-height:200px;overflow:auto;white-space:pre-wrap}
      #__arena_agent_billing_panel__ p.boundline{font-size:11px;color:var(--ab-dim);margin:4px 0 0;line-height:1.45}
      #__arena_agent_billing_panel__ pre.pool{max-height:220px;margin:6px 0 0}
      #__arena_agent_billing_panel__ details.poolhits{margin-top:6px;font-size:11px;color:var(--ab-dim)}
      #__arena_agent_billing_panel__ details.poolhits pre{max-height:120px;margin-top:4px}
      #__arena_agent_billing_panel__ .candlist,#__arena_agent_billing_panel__ .candrest,#__arena_agent_billing_panel__ .histlist{font-size:11px;color:var(--ab-dim)}
      #__arena_agent_billing_panel__ .candlist div,#__arena_agent_billing_panel__ .candrest div,#__arena_agent_billing_panel__ .histlist div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #__arena_agent_billing_panel__ pre.status{max-height:132px}
      #__arena_agent_billing_panel__ .modelcard{flex:0 0 auto;padding:12px 12px 10px;border-bottom:1px solid var(--ab-line);background:var(--ab-bg)}
      #__arena_agent_billing_panel__ .modellabel{font-size:11px;letter-spacing:.04em;color:var(--ab-dim)}
      #__arena_agent_billing_panel__ .modelname{font-size:20px;font-weight:700;line-height:1.3;margin:5px 0 7px;overflow-wrap:anywhere;color:var(--ab-fg)}
      #__arena_agent_billing_panel__ .modelstage{font-size:12px;font-weight:600;color:var(--ab-warn)}
      #__arena_agent_billing_panel__ .modelnote{font-size:11px;line-height:1.4;color:var(--ab-dim);margin-top:4px}
      #__arena_agent_billing_panel__ .modelcard[data-tone="candidate"] .modelstage{color:var(--ab-ok)}
      #__arena_agent_billing_panel__ .modelcard[data-tone="excluded"] .modelstage{color:var(--ab-bad)}
      #__arena_agent_billing_panel__ .mechanisms{flex:0 0 auto;padding:6px 10px;background:var(--ab-bg2);font-size:11px;line-height:1.5;border-bottom:1px solid var(--ab-line)}
      #__arena_agent_billing_panel__ .mechanisms div+div{margin-top:2px}
      #__arena_agent_billing_panel__ .candlist div,#__arena_agent_billing_panel__ .candrest div{font-size:13px;font-weight:600;line-height:1.7;color:var(--ab-fg)}
    </style><div class="box">
      <div class="head">
        <span class="title">Arena 计费筛选</span>
        <span class="headver" title="页面实际运行的脚本版本">${panelV2ScriptVersion()}</span>
        <span class="state">待开始</span>
        <span class="acts"><button class="start">开始</button><button class="stop">暂停</button><button class="resume">继续</button></span>
        <button class="fold" title="展开 / 收起">▸</button>
      </div>
      <div class="heads"></div>
      <section class="modelcard" data-tone="waiting" aria-live="polite">
        <div class="modellabel">当前会话</div>
        <div class="modelname">模型待识别</div>
        <div class="modelstage">等待开始探测</div>
        <div class="modelnote">输出完成并取得完整计价后再识别。</div>
      </section>
      <div class="mechanisms"><div>有思考：立即停止并排除</div><div>无思考：等本轮完整计价，再识别</div></div>
      <p class="boundline">${TARGET_POOL_COPY.collapseLine}</p>
      <div class="body">
      <section class="sec poolbox">
        <details class="targetdetails"><summary>目标模型名单与计价规则 <span class="targetcount">7 条 key（固定）</span></summary>
        <pre class="pooltargetssay">名单：准备中…</pre>
        <pre class="poolmultisay">多分支价：能否命中，以实际费用判定为准。</pre>
        </details>
      </section>
      <section class="sec">
        <div class="row"><span class="k">判定</span><span class="v decision"></span></div>
        <div class="row"><span class="k">命名结果</span><span class="v nameline"></span></div>
        <div class="row"><span class="k">本轮可验证候选</span><span class="v candtotal"></span></div>
        <div class="candlist"></div>
        <div class="candrest" hidden></div>
        <button class="candmore" hidden>查看全部候选（0）</button>
        <details class="judgewrap"><summary>判定详情与命名依据</summary>
          <pre class="pool">候选池：准备中…</pre>
          <details class="poolhits"><summary>命中的候选 key（0 条，可展开）</summary><pre class="poolhitlist">（尚未判定）</pre></details>
        </details>
      </section>
      <section class="sec">
        <pre class="status"></pre>
        <div class="kv"><label class="probecyclelabel">探针轮次：—</label></div>
        <div class="kv"><label class="probelimitlabel">探针上限：不限</label><input class="probelimit" type="text" inputmode="decimal" placeholder="留空 = 不限" /></div>
        <div class="kv"><label class="chargedlimitlabel">费用上限：不限</label><input class="chargedlimit" type="text" inputmode="decimal" placeholder="留空 = 不限" /></div>
        <div class="hint limitsay">留空 = 不限；只有填正数才会在到线时停止。</div>
        <details class="histwrap"><summary>历史候选（仅供参考）</summary>
          <div class="row"><span class="k">历史候选（仅供参考）</span><span class="v histtotal"></span></div>
          <div class="histlist"></div>
        </details>
      </section>
      <section class="sec">
        <details class="cfgwarp"><summary>探针 / 任务 / 轮数 / 目标 配置</summary>
          <label>目标候选</label><select class="target"><option value="opus">Claude Opus（任一价格档）</option><option value="opus5.5">Claude Opus 5.5</option><option value="opus5">Claude Opus 5</option></select>
          <label>轮换探针（每行一条，命中前循环）</label><textarea class="probe"></textarea>
          <label class="probenotecopy">探针池：100 条素材，轮内无放回；一轮用尽自动进入下一轮（旧「命中前循环」口径已废弃）</label>
          <label>目标命中后的任务轮数</label><input class="rounds" type="number" min="0" max="20" />
          <label>任务提示词（每行一轮，循环使用）</label><textarea class="tasks"></textarea>
        </details>
      </section>
      <section class="sec">
        <details class="diagwrap"><summary>费用读数 / 识别详情 / 诊断</summary>
          <div class="costbox">
            <div class="costhead"><span>当前会话费用（只读）</span><button class="refresh">刷新</button></div>
            <pre class="cost">费用读数：准备中…</pre>
            <button class="restore" hidden>覆盖开关没生效，点这里恢复</button>
          </div>
          <div class="identbox">
            <div class="costhead"><span>当前会话模型候选（内嵌内核）</span><span><button class="identrefresh">刷新</button><button class="export" disabled>导出当前会话账单 JSON</button></span></div>
            <pre class="identify">识别：准备中…</pre>
          </div>
        </details>
      </section>
      </div>
    </div>`;

  function panelV2LoadState() {
    try {
      const raw = localStorage.getItem(PANEL_V2_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return { collapsed: true, x: null, y: null };
      return {
        collapsed: parsed.collapsed !== false,          // 默认折叠：只有显式 false 才展开
        x: Number.isFinite(Number(parsed.x)) && parsed.x !== null ? Number(parsed.x) : null,
        y: Number.isFinite(Number(parsed.y)) && parsed.y !== null ? Number(parsed.y) : null,
      };
    } catch (_) { return { collapsed: true, x: null, y: null }; }
  }

  function panelV2SaveState(patch) {
    panelV2State = Object.assign({}, panelV2State, patch || {});
    try { localStorage.setItem(PANEL_V2_KEY, JSON.stringify(panelV2State)); } catch (_) {}
    return panelV2State;
  }

  function panelV2Viewport() {
    const w = typeof innerWidth === 'number' ? innerWidth : null;
    const h = typeof innerHeight === 'number' ? innerHeight : null;
    return { w, h };
  }

  function panelV2Clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Number.isFinite(min) && n < min) return min;
    if (Number.isFinite(max) && n > max) return max;
    return n;
  }

  /** 折叠 / 展开（默认折叠；状态落 localStorage）。 */
  function panelV2SetCollapsed(collapsed) {
    panelV2State = panelV2SaveState({ collapsed: collapsed === true });
    if (panel && panel.body) panel.body.hidden = panelV2State.collapsed === true;
    if (panel && panel.fold) panel.fold.textContent = panelV2State.collapsed === true ? PANEL_V2_COPY.foldClose : PANEL_V2_COPY.foldOpen;
    return panelV2State.collapsed === true;
  }

  function panelV2ApplyPosition() {
    const host = panel && panel.host ? panel.host : null;
    if (!host || !host.style) return null;
    const vp = panelV2Viewport();
    const pos = {
      x: panelV2State.x === null ? null : panelV2Clamp(panelV2State.x, 0, vp.w === null ? null : Math.max(0, vp.w - 60)),
      y: panelV2State.y === null ? null : panelV2Clamp(panelV2State.y, 0, vp.h === null ? null : Math.max(0, vp.h - 40)),
    };
    if (pos.x !== null) { host.style.left = pos.x + 'px'; host.style.right = 'auto'; }
    if (pos.y !== null) { host.style.top = pos.y + 'px'; }
    return pos;
  }

  function panelV2StatusLines() {
    try { if (typeof automationStatusLines === 'function') return automationStatusLines(); } catch (_) {}
    return [];
  }

  function panelV2SummaryText() {
    let base = null;
    try { if (typeof automationPanelSummaryLine === 'function') base = automationPanelSummaryLine(); } catch (_) {}
    if (typeof base !== 'string' || !base) base = '待开始｜参考·目标｜余—';
    // ★ R3（卡 I′）：把费用速览接到**始终可见**的这一行上（见 panelV2CostDigest 的根因说明）。
    const digest = panelV2CostDigest();
    return digest ? base + '｜' + digest : base;
  }

  /**
   * ★ 运行版本标记（总工 2026-10-11 要求；GPT 的 R3 最小验收清单第 1 项：截图必须自带运行版本）。
   * 版本号由构建工具从 `00-header.js` 的 `@version` 注入 `__IDENTIFY_BUILD__.scriptVersion`。
   * 只用 `typeof` 探测（测试沙箱里可能没有这个常量 ⇒ 渲染空串，绝不抛），只渲染一行、不重排面板结构。
   */
  function panelV2ScriptVersion() {
    try {
      const build = typeof __IDENTIFY_BUILD__ === 'object' && __IDENTIFY_BUILD__ ? __IDENTIFY_BUILD__ : null;
      const v = build && typeof build.scriptVersion === 'string' ? build.scriptVersion.trim() : '';
      return v && v !== 'unknown' ? 'v' + v : '';
    } catch (_) { return ''; }
  }

  /**
   * ★★ R3（用户真机缺陷「脚本没有显示额度」）· 折叠摘要里的**费用速览**。
   *
   * 源码诊断（候选根因，见 falsify/evidence/t-mv35cpjj-npvmyk/attempt-1/r3-*）：
   *   费用读数区块（`<pre class="cost">`）在 v2 面板里被放在
   *   `section.sec > details.diagwrap`（`<summary>费用读数 / 识别详情 / 诊断</summary>`，**默认收起**）
   *   里，而整个 `.body` 在默认折叠的面板下又 `hidden` ⇒ **不点两层就看不到任何费用内容**；
   *   折叠态那行摘要（.heads）原本只写「状态｜模式·池｜余N」，一个费用字段都没有。
   *   ⇒ 用户看到的就是"没有显示额度"，与现场症状一致。
   *
   * 本函数把**已读到的**费用摘要提到那行始终可见的摘要里。纪律：
   *   · 只读 `panel.cost` 自报的 `data-state` 与已渲染文本；
   *   · **不发任何请求、不改任何状态、不触发任何重判**（纯读取）。
   */
  function panelV2CostDigest() {
    try {
      if (!panel || !panel.cost) return '';
      const state = panel.cost.dataset ? String(panel.cost.dataset.state || '') : '';
      const labels = {
        'no-session': '无会话', loading: '读取中', error: '读取失败',
        stopped: '已停止', ready: '已读取', idle: '待读取',
      };
      const label = labels[state] || '待读取';
      if (state !== 'ready') return '费用：' + label;
      const text = String(panel.cost.textContent || '');
      const pick = (name) => {
        const m = text.match(new RegExp('^\\s*' + name + '\\s+(\\S.*)$', 'm'));
        return m ? m[1].trim() : '';
      };
      const actual = pick('实际成本');
      const charged = pick('用户扣费');
      if (!actual && !charged) return '费用：' + label;
      return '费用：' + label + ' 实际 ' + (actual || '未提供') + ' · 扣费 ' + (charged || '未提供');
    } catch (_) { return ''; }
  }

  let panelV2CostObserver = null;

  /**
   * ★ R3：把「费用读数」的变化同步进上面那行始终可见的摘要。
   * 只**观察** `<pre class="cost">` 的文本与 data-state 变化，不发起请求、不改状态；
   * 环境没有 MutationObserver（离线 DOM 桩）时静默跳过 —— 此时摘要仍会在下次 renderPanelV2 时刷新。
   */
  function panelV2WatchCostText() {
    try {
      if (panelV2CostObserver) { panelV2CostObserver.disconnect(); panelV2CostObserver = null; }
      if (typeof MutationObserver !== 'function' || !panel || !panel.cost) return false;
      panelV2CostObserver = new MutationObserver(() => {
        try { if (panel && panel.heads) panel.heads.textContent = panelV2SummaryText(); } catch (_) {}
      });
      panelV2CostObserver.observe(panel.cost, {
        childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-state'],
      });
      return true;
    } catch (_) { panelV2CostObserver = null; return false; }
  }

  function panelV2StatusPhrase() {
    try { if (typeof automationPanelStatusPhrase === 'function') return automationPanelStatusPhrase(); } catch (_) {}
    return PANEL_V2_COPY.stateIdle;
  }

  function panelV2VerdictLines() {
    try { if (typeof automationPanelVerdictLines === 'function') return automationPanelVerdictLines(); } catch (_) {}
    return { decision: '—', name: '—', thinking: '—', evidence: '等待中' };
  }

  function panelV2Labels() {
    const p = config && config.probeLimit !== undefined ? config.probeLimit : null;
    const c = config && config.chargedLimitUsd !== undefined ? config.chargedLimitUsd : null;
    let pl = '不限';
    let cl = '不限';
    try {
      if (typeof automationLimitLabel === 'function') { pl = automationLimitLabel(p); cl = automationLimitLabel(c); }
      else { pl = p === null || p === undefined || !(Number(p) > 0) ? '不限' : String(Number(p)); cl = c === null || c === undefined || !(Number(c) > 0) ? '不限' : String(Number(c)); }
    } catch (_) {}
    return { probeLimit: pl, chargedLimit: cl };
  }

  function panelV2NumberInputText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /**
   * ★ 0.6.3：面板「探针轮次」行的文案（逐字口径 `探针轮次：第 N 轮 / 本轮已用 x / 共 y / 累计 z`）。
   *   数据来自 30-automation.js 的 automationPanelCycleLine()；拿不到就如实标注，绝不编造数字。
   */
  function panelV2ProbeCycleText() {
    try {
      if (typeof automationPanelCycleLine === 'function') return automationPanelCycleLine();
    } catch (_) {}
    return '探针轮次：—（探针池不可用）';
  }

  /** 上限输入：空 = 不限（写 null）；非法输入 ⇒ 不改状态 + 明确提示。 */
  function panelV2ApplyLimit(field) {
    const input = field === 'probeLimit' ? panel.probelimit : panel.chargedlimit;
    if (!input) return null;
    let result = null;
    try {
      if (typeof automationSetLimit === 'function') result = automationSetLimit(field, input.value);
      else result = { ok: true, value: null, unlimited: true };
    } catch (_) { result = { ok: false, error: 'THROWN' }; }
    if (result && result.ok === true) {
      input.value = panelV2NumberInputText(config[field]);
      panelV2Notice = null;
    } else {
      input.value = panelV2NumberInputText(config[field]);
      panelV2Notice = PANEL_V2_COPY.limitInvalid;
    }
    renderPanelV2();
    return result;
  }

  function panelV2HistorySource() {
    try {
      if (typeof window !== 'undefined' && window && window.__ARENA_AGENT_BILLING_HISTORY__) {
        return window.__ARENA_AGENT_BILLING_HISTORY__;
      }
    } catch (_) {}
    try {
      if (typeof identifyHistoryView !== 'undefined' && identifyHistoryView) return identifyHistoryView;
    } catch (_) {}
    return null;
  }

  /** 当前会话模型卡：输出和本轮计价均就绪后才展示价格候选。 */
  function panelV2ModelView() {
    const sid = typeof currentSessionId === 'function' ? currentSessionId() : run.sessionId;
    const active = !!run.sessionId && (!sid || run.sessionId === sid);
    const round = active && run.rounds && typeof run.rounds === 'object' ? run.rounds : {};
    const view = { title: '模型待识别', label: '当前会话', stage: '等待开始探测', ready: false, names: [], note: '拿到本轮完整计价就识别。', tone: 'waiting' };
    if (active && run.thinking && run.thinking.state === 'SEEN') {
      return Object.assign(view, { title: '思考已排除', stage: '检测到思考，立即停止并排除', note: '本次会话不再进入价格筛选。', tone: 'excluded' });
    }
    // ★ 用户口径（2026-10-11）：「得到了计费，那就可以直接判断了。」⇒ 唯一的等待条件是**计价未到**；
    //   「输出未完成」不再是独立等待阶段（真机反例：完成态被迟到的连接收尾抹掉 ⇒ 永久显示「等待输出完成」）。
    if (active && !round.billingReady) {
      view.stage = run.phase === 'PAUSED' ? '计价未到，已暂停'
        : (round.outputComplete ? '等待本轮完整计价' : '等待本轮输出与完整计价');
      return view;
    }
    const src = typeof identifyView === 'object' && identifyView ? identifyView.source : null;
    const report = targetPoolCurrentReport();
    if (!active || !round.billingReady || !src || src.sid !== sid || !report) {
      if (sid) view.stage = '等待当前会话计价';
      return view;
    }
    const names = Array.from(new Set((Array.isArray(report.complete) ? report.complete : [])
      .filter((row) => row && typeof row === 'object' && row.key)
      .map((row) => String(row.disp || row.label || row.key))));
    if (!names.length) {
      return Object.assign(view, { title: '暂无法识别', label: '价格识别结果', stage: '完整计价已到，暂无可验证候选', ready: true, note: '本次价格证据未能识别模型候选。', tone: 'unresolved' });
    }
    return Object.assign(view, {
      title: names.slice(0, 2).join(' / ') + (names.length > 2 ? ' 等 ' + names.length + ' 个' : ''),
      label: '价格候选 · ' + names.length + ' 个', names, ready: true,
      stage: run.decision === 'KEEP' ? '目标价格兼容，已保留' : run.decision === 'ARCHIVE' ? '价格未命中目标，已排除' : '计价就绪，已识别价格候选',
      note: names.length > 1 ? '费用证据仍兼容多个候选，同价时无法区分。' : '价格匹配不代表模型身份已确认。',
      tone: run.decision === 'ARCHIVE' ? 'excluded' : 'candidate',
    });
  }

  /** 候选清单：默认只显前 5 条（其余靠「查看全部候选（N）」），长文本一律省略号。 */
  function panelV2RenderCandidates() {
    if (!panel || !panel.candlist) return;
    const model = panelV2ModelView();
    if (!model.ready) {
      panel.candlist.innerHTML = '<div>' + model.stage + '</div>';
      if (panel.candrest) { panel.candrest.innerHTML = ''; panel.candrest.hidden = true; }
      if (panel.candmore) panel.candmore.hidden = true;
      if (panel.candtotal) panel.candtotal.textContent = model.tone === 'excluded' ? '已排除' : '等待完整证据';
      return;
    }
    const report = targetPoolCurrentReport();
    const rows = (report && Array.isArray(report.complete) ? report.complete : [])
      .filter((row) => row && typeof row === 'object' && typeof row.key === 'string' && row.key);
    const line = (row) => String(row.disp || row.label || row.key);
    let preview = null;
    try { if (typeof automationCandidatesPreview === 'function') preview = automationCandidatesPreview(report, 5); } catch (_) {}
    if (!preview) {
      preview = {
        total: rows.length,
        lines: rows.slice(0, 5).map(line),
        more: Math.max(0, rows.length - 5),
        truncated: rows.length > 5,
        moreLabel: '查看全部候选（' + rows.length + '）',
        collapseLabel: '收起候选',
      };
    }
    const first = rows.slice(0, 5).map(line);
    const rest = rows.slice(5);
    panel.candlist.innerHTML = first.length
      ? first.map((t) => '<div>' + String(t).replace(/[<>&]/g, '') + '</div>').join('')
      : '<div>' + PANEL_V2_COPY.noCandidates + '</div>';
    if (panel.candrest) {
      panel.candrest.innerHTML = rest.map((row) => '<div>' + String(line(row)).replace(/[<>&]/g, '') + '</div>').join('');
      panel.candrest.hidden = !(panelV2Expanded && rest.length > 0);
    }
    if (panel.candmore) {
      panel.candmore.hidden = rest.length === 0;
      panel.candmore.textContent = panelV2Expanded
        ? (preview.collapseLabel || PANEL_V2_COPY.collapseCands)
        : (preview.moreLabel || (PANEL_V2_COPY.viewAll + '（' + rows.length + '）'));
    }
    if (panel.candtotal) panel.candtotal.textContent = rows.length ? rows.length + ' 条（默认只列前 5）' : '0 条';
  }

  function panelV2RenderHistory() {
    if (!panel || !panel.histlist) return;
    let preview = null;
    try { if (typeof automationHistoryPreview === 'function') preview = automationHistoryPreview(panelV2HistorySource()); } catch (_) {}
    if (!preview) preview = { total: 0, lines: [], empty: PANEL_V2_COPY.noHistory };
    panel.histlist.innerHTML = (preview.lines && preview.lines.length)
      ? preview.lines.map((t) => '<div>' + String(t).replace(/[<>&]/g, '') + '</div>').join('')
      : '<div>' + PANEL_V2_COPY.noHistory + '</div>';
    if (panel.histtotal) panel.histtotal.textContent = preview.total ? preview.total + ' 条（仅供参考）' : '仅供参考';
  }

  /** 重绘卡 G 新增的那几块（不改任何原有渲染路径）。 */
  function renderPanelV2() {
    if (!panel) return false;
    try {
      const collapsed = panelV2State.collapsed === true;
      const model = panelV2ModelView();
      if (panel.modelname) panel.modelname.textContent = model.title;
      if (panel.modellabel) panel.modellabel.textContent = model.label;
      if (panel.modelstage) panel.modelstage.textContent = model.stage;
      if (panel.modelnote) panel.modelnote.textContent = model.note;
      if (panel.modelcard && panel.modelcard.dataset) panel.modelcard.dataset.tone = model.tone;
      // ① 顶部操作栏：状态短语始终可见；折叠态额外显示「状态｜模式·池｜余M」一行摘要。
      if (panel.state) {
        panel.state.textContent = panelV2StatusPhrase();
        panel.state.style.borderLeftColor = /暂停|已停止/.test(panel.state.textContent) ? 'var(--ab-bad)' : 'var(--ab-line)';
      }
      if (panel.heads) {
        panel.heads.textContent = panelV2SummaryText();
        panel.heads.hidden = false;
      }
      // ④ 判定 / 命名 / 候选
      const verdict = panelV2VerdictLines();
      if (panel.decision) panel.decision.textContent = model.ready ? verdict.decision : model.stage;
      if (panel.nameline) panel.nameline.textContent = model.ready ? verdict.name : '识别后命名';
      if (panel.targetcount) {
        // ★ 徽标恒为「N 条 key（固定）」（N = 固定名单条数 = 7）—— 不再显示会变的自动化简称，
        //   免得折叠态出现"静态写 7、动态写目标7"这种自相矛盾。
        panel.targetcount.textContent = targetPoolCountBadgeText();
      }
      // ⑤ 本轮计数 + 剩余探针 + 上限
      const labels = panelV2Labels();
      if (panel.probelimitlabel) panel.probelimitlabel.textContent = '探针上限：' + labels.probeLimit;
      // ★ 0.6.3：探针轮次行（第 N 轮 / 本轮已用 x / 共 y / 累计 z）；池不可用时如实标注。
      if (panel.probecyclelabel) panel.probecyclelabel.textContent = panelV2ProbeCycleText();
      if (panel.chargedlimitlabel) panel.chargedlimitlabel.textContent = '费用上限：' + labels.chargedLimit;
      if (panel.limitsay) panel.limitsay.textContent = panelV2Notice || PANEL_V2_COPY.limitHint;
      if (panel.probelimit && document.activeElement !== panel.probelimit) panel.probelimit.value = panelV2NumberInputText(config.probeLimit);
      if (panel.chargedlimit && document.activeElement !== panel.chargedlimit) panel.chargedlimit.value = panelV2NumberInputText(config.chargedLimitUsd);
      panelV2RenderCandidates();
      panelV2RenderHistory();
      if (panel.body) panel.body.hidden = collapsed;
      if (panel.fold) panel.fold.textContent = collapsed ? PANEL_V2_COPY.foldClose : PANEL_V2_COPY.foldOpen;
    } catch (_) {}
    return true;
  }

  function panelV2Metrics() {
    const host = panel && panel.host ? panel.host : null;
    const box = host && typeof host.querySelector === 'function' ? host.querySelector('.box') : null;
    const body = panel && panel.body ? panel.body : null;
    const rectOf = (el) => {
      try {
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect() || {};
          const x = Number(r.x !== undefined ? r.x : r.left) || 0;
          const y = Number(r.y !== undefined ? r.y : r.top) || 0;
          const w = Number(r.width) || 0;
          const h = Number(r.height) || 0;
          return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), bottom: Math.round(y + h), right: Math.round(x + w) };
        }
      } catch (_) {}
      return null;
    };
    const styleOf = (el, prop) => { try { return el && el.style ? String(el.style[prop] || '') : ''; } catch (_) { return ''; } };
    let pageScrollHeight = null;
    try {
      if (typeof document !== 'undefined' && document && document.body) pageScrollHeight = Number(document.body.scrollHeight) || 0;
    } catch (_) {}
    return {
      version: 'g-panel-v2',
      collapsed: panelV2State.collapsed === true,
      position: { x: panelV2State.x, y: panelV2State.y },
      viewport: panelV2Viewport(),
      host: rectOf(host), box: rectOf(box), bodyRect: rectOf(body),
      hostPositionCss: styleOf(host, 'position'), hostZIndexCss: styleOf(host, 'zIndex'),
      bodyScrollHeight: body ? Number(body.scrollHeight) || 0 : 0,
      bodyClientHeight: body ? Number(body.clientHeight) || 0 : 0,
      pageScrollHeight,
      summaryText: panel && panel.heads ? String(panel.heads.textContent || '') : null,
    };
  }

  const panelV2Api = {
    version: 'g-panel-v2',
    storageKey: PANEL_V2_KEY,
    expand: () => panelV2SetCollapsed(false),
    collapse: () => panelV2SetCollapsed(true),
    toggle: () => panelV2SetCollapsed(panelV2State.collapsed !== true),
    isCollapsed: () => panelV2State.collapsed === true,
    metrics: panelV2Metrics,
    render: renderPanelV2,
    copy: PANEL_V2_COPY,
  };

  /**
   * 把默认面板换成卡 G 的极简浮层：只**重建引用 + 重新接线 + 首次重绘**，
   * 不碰任何原有函数体（复核基线不变），也不新增任何归档 / 发送 / 取费用调用。
   */
  function applyPanelV2() {
    if (!panel || !panel.host) return false;
    const host = panel.host;
    host.innerHTML = PANEL_V2_MARKUP;
    panelV2State = panelV2LoadState();
    panelV2Expanded = false;
    panelV2Notice = null;
    panel.body = host.querySelector('.body');
    panel.modelcard = host.querySelector('.modelcard');
    panel.modellabel = host.querySelector('.modellabel');
    panel.modelname = host.querySelector('.modelname');
    panel.modelstage = host.querySelector('.modelstage');
    panel.modelnote = host.querySelector('.modelnote');
    panel.status = host.querySelector('.status');
    panel.probe = host.querySelector('.probe');
    panel.rounds = host.querySelector('.rounds');
    panel.tasks = host.querySelector('.tasks');
    panel.target = host.querySelector('.target');
    panel.cost = host.querySelector('.cost');
    panel.refresh = host.querySelector('.refresh');
    panel.restore = host.querySelector('.restore');
    panel.identify = host.querySelector('.identify');
    panel.identrefresh = host.querySelector('.identrefresh');
    panel.export = host.querySelector('.export');
    panel.poolthought = host.querySelector('.poolthought');
    panel.poolthoughtsay = host.querySelector('.poolthoughtsay');
    panel.pooltargets = host.querySelector('.pooltargetssay');
    panel.targetcount = host.querySelector('.targetcount');
    panel.poolmultisay = host.querySelector('.poolmultisay');
    panel.pool = host.querySelector('.pool');
    panel.poolhits = host.querySelector('.poolhits');
    panel.poolhitlist = host.querySelector('.poolhitlist');
    // 卡 G 新增引用（① 顶部操作栏 / ④ 判定 / ⑤ 计数与上限）
    panel.head = host.querySelector('.head');
    panel.heads = host.querySelector('.heads');
    panel.fold = host.querySelector('.fold');
    panel.state = host.querySelector('.state');
    panel.decision = host.querySelector('.decision');
    panel.nameline = host.querySelector('.nameline');
    panel.probelimit = host.querySelector('.probelimit');
    panel.probelimitlabel = host.querySelector('.probelimitlabel');
    panel.chargedlimit = host.querySelector('.chargedlimit');
    panel.chargedlimitlabel = host.querySelector('.chargedlimitlabel');
    panel.limitsay = host.querySelector('.limitsay');
    panel.probecyclelabel = host.querySelector('.probecyclelabel');
    panel.candlist = host.querySelector('.candlist');
    panel.candrest = host.querySelector('.candrest');
    panel.candmore = host.querySelector('.candmore');
    panel.candtotal = host.querySelector('.candtotal');
    panel.histlist = host.querySelector('.histlist');
    panel.histtotal = host.querySelector('.histtotal');

    // 值 + 接线（与原来同一套入口；两个开关仍只走 targetPoolApplyControls + refreshIdentify）
    panel.probe.value = config.probeText;
    panel.target.value = config.target;
    panel.rounds.value = config.rounds;
    panel.tasks.value = config.tasks;
    panel.probe.onchange = () => { config.probeText = panel.probe.value; save(); };
    panel.target.onchange = () => { config.target = panel.target.value; save(); };
    panel.rounds.onchange = () => { config.rounds = Math.max(0, Math.min(20, Math.floor(Number(panel.rounds.value) || 0))); panel.rounds.value = config.rounds; save(); };
    panel.tasks.onchange = () => { config.tasks = panel.tasks.value || DEFAULT_TASK; save(); };
    host.querySelector('.start').onclick = () => void startAutomation();
    host.querySelector('.stop').onclick = stopAutomation;
    host.querySelector('.resume').onclick = () => void resumeAutomation();
    panel.refresh.onclick = () => void refreshCost(true);
    panel.restore.onclick = () => { enableBillingFlag(); void refreshCost(true); };
    panel.identrefresh.onclick = () => { refreshIdentify(); if (!identifyView.source) notify('尚未抓到当前会话的 /cost 响应，稍后自动重试'); };
    panel.export.onclick = exportSessionCost;
    if (panel.probelimit) {
      panel.probelimit.value = panelV2NumberInputText(config.probeLimit);
      panel.probelimit.onchange = () => panelV2ApplyLimit('probeLimit');
    }
    if (panel.chargedlimit) {
      panel.chargedlimit.value = panelV2NumberInputText(config.chargedLimitUsd);
      panel.chargedlimit.onchange = () => panelV2ApplyLimit('chargedLimitUsd');
    }
    if (panel.candmore) {
      panel.candmore.onclick = () => { panelV2Expanded = !panelV2Expanded; panelV2RenderCandidates(); };
    }
    host.querySelector('.fold').onclick = () => { panelV2SetCollapsed(panelV2State.collapsed !== true); renderPanelV2(); };
    // 点标题栏展开 / 收起；拖动移动位置（位置落 localStorage，跨刷新恢复）
    if (panel.head) {
      panel.head.onmousedown = (event) => {
        // 顶部操作栏里的控件（开始 / 暂停 / 继续 / 折叠）不触发拖动，也不触发"点空白折叠"
        const tag = event && event.target && event.target.tagName ? String(event.target.tagName).toUpperCase() : '';
        if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'INPUT' || tag === 'A') return;
        const rect = (() => { try { return host.getBoundingClientRect ? host.getBoundingClientRect() : null; } catch (_) { return null; } })();
        panelV2Drag = {
          startX: Number(event && event.clientX) || 0,
          startY: Number(event && event.clientY) || 0,
          originX: rect ? Number(rect.left) || 0 : 0,
          originY: rect ? Number(rect.top) || 0 : 0,
          moved: false,
        };
      };
    }
    try {
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('mousemove', (event) => {
          if (!panelV2Drag) return;
          const dx = (Number(event && event.clientX) || 0) - panelV2Drag.startX;
          const dy = (Number(event && event.clientY) || 0) - panelV2Drag.startY;
          if (!panelV2Drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          panelV2Drag.moved = true;
          panelV2State = Object.assign({}, panelV2State, { x: panelV2Drag.originX + dx, y: panelV2Drag.originY + dy });
          panelV2ApplyPosition();
        });
        document.addEventListener('mouseup', () => {
          if (!panelV2Drag) return;
          const moved = panelV2Drag.moved === true;
          panelV2Drag = null;
          if (moved) panelV2SaveState({ x: panelV2State.x, y: panelV2State.y });
          else { panelV2SetCollapsed(panelV2State.collapsed !== true); renderPanelV2(); }
        });
      }
    } catch (_) {}
    panelV2ApplyPosition();
    panelV2SetCollapsed(panelV2State.collapsed === true);
    wireTargetPoolControls();
    renderStatus();
    renderCost();
    renderIdentify();
    renderTargetPool();
    renderPanelV2();
    // ★ R3：面板重建后重新挂"费用 → 摘要行"的只读观察（不请求、不改状态）。
    panelV2WatchCostText();
    try {
      if (typeof window !== 'undefined' && window) window.__ARENA_AGENT_BILLING_PANEL__ = panelV2Api;
    } catch (_) {}
    return true;
  }
// ═══════════════════════════════════════════════════════════════════════════
  // 当前会话模型候选（内嵌内核；与 CLI 同一 kernel、同一份压缩目录）
  //
  // 面板在没有 CLI 的浏览器里独立给出结论：kernel 已内嵌，目录以压缩 bundle 内嵌，
  // 只有「抓到/拉到原始 /cost 响应」这一件事需要页面自己完成。
  // 这里只做 DOM 与状态；所有判定都在 12-identify-block 的纯函数里（parity 测试覆盖）。
  // ═══════════════════════════════════════════════════════════════════════════
  const identifyView = { source: null, report: null, err: null, lastExport: null };

  /** 记下**当前会话**的原始 /cost 响应文本（其它会话一律忽略，避免串会话）。 */
  function setIdentifySource(sid, text) {
    if (!sid || typeof text !== 'string' || !text) return;
    if (sid !== currentSessionId()) return;
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    identifyView.source = { sid, text, json, at: Date.now() };
  }

  /** 由已抓到的原始响应重算识别（脱敏后的对象与导出的是同一个 ⇒ 两边结论必然一致）。 */
  function refreshIdentify() {
    identifyView.err = null;
    identifyView.report = null;
    const src = identifyView.source;
    if (!src || src.sid !== currentSessionId()) { renderIdentify(); return; }
    try {
      const clean = sanitizeCostForExport(src.json);
      identifyView.report = identifyReport(clean.json);
    } catch (e) {
      identifyView.err = String((e && e.message) || e);
    }
    renderIdentify();
  }

  function exportSessionCost() {
    const src = identifyView.source;
    if (!src || src.sid !== currentSessionId()) {
      notify('还没抓到当前会话的 /cost 响应：先点「刷新」再导出');
      return;
    }
    const out = buildCostExportText(src);
    const blob = new Blob([out.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = out.name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    identifyView.lastExport = { name: out.name, bytes: blob.size, removed: out.removed.length };
    renderIdentify();
    // 复算方式写在提示里，导出文件只落本地、不上传。
    notify(`已导出 ${out.name}（${blob.size} 字节，剔除敏感键 ${out.removed.length} 个，只落本地）\n`
      + `复算：node tools/identify-session.mjs --cost ${out.name} --catalog data/arena-models-derived.json`);
  }

  function renderIdentify() {
    if (!panel || !panel.identify) return;
    const isCurrent = identifyView.source && identifyView.source.sid === currentSessionId();
    if (panel.export) panel.export.disabled = !isCurrent;
    const currentRun = typeof run === 'object' && run && run.owned === true && run.sessionId === currentSessionId();
    const round = currentRun && run.rounds && typeof run.rounds === 'object' ? run.rounds : null;
    const thinkingSeen = currentRun && run.thinking && run.thinking.state === 'SEEN';
    if (thinkingSeen || (round && !round.billingReady)) {
      let stage = thinkingSeen ? '检测到思考，立即停止并排除'
        : (round.outputComplete ? '等待本轮完整计价' : '等待本轮输出与完整计价');
      try {
        if (typeof panelV2ModelView === 'function') {
          const model = panelV2ModelView();
          if (model && typeof model.stage === 'string') stage = model.stage;
        }
      } catch (_) {}
      panel.identify.textContent = '识别：' + stage + (thinkingSeen ? '\n本次会话不再进入价格筛选。' : '\n拿到本轮完整计价就显示价格候选。');
      return;
    }
    const tail = [];
    if (identifyView.err) tail.push('识别失败：' + identifyView.err);
    if (identifyView.lastExport) {
      tail.push(`上次导出 ${identifyView.lastExport.name}（${identifyView.lastExport.bytes} 字节，剔除敏感键 ${identifyView.lastExport.removed} 个；只落本地）`);
    }
    let head;
    if (!isCurrent) head = '识别：尚未抓到当前会话的原始 /cost 响应（点「刷新」）';
    else if (identifyView.err) head = '识别：失败';
    else if (!identifyView.report) head = '识别：准备中…';
    else head = renderIdentifyText(identifyView.report);
    panel.identify.textContent = [head].concat(tail).join('\n\n');
  }

  /** 与 CLI 同一份输入时的可复核指纹（面板上直接显示，便于口头核对复算结果）。 */
  function identifyFingerprint() {
    const b = __IDENTIFY_BUILD__;
    return {
      kernelHash: b.kernelHash,
      bundleHash: b.bundleHash,
      ruleVersion: b.ruleVersion,
      catalogRows: __IDENTIFY_BUNDLE__.catalogRows,
      pricedRows: __IDENTIFY_BUNDLE__.pricedRows,
      unpricedRows: __IDENTIFY_BUNDLE__.unpricedRows,
    };
  }

  // 费用面板生命周期；只管理本模块，不改变筛选、网络钩子或权限开关。
  const costView = {
    timer: null, lastPath: null, busy: false, last: null, err: null,
    running: false, generation: 0, controller: null, timeout: null,
    status: 'idle', updatedAt: null, listeners: false
  };
  function literalsAsStrings(node) {
    return JSON.parse(JSON.stringify(node).replace(/:(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, ':"$1"'));
  }
  function show(v) { return v === undefined || v === null || v === '' ? '未提供' : String(v); }
  function costAmount(v) {
    if (v === undefined || v === null || v === '') return '未知 · 未提供';
    const text = String(v);
    if (!/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return '未知 · 格式异常';
    return '$' + text + (/^0+(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(text) ? ' · 零费用' : '');
  }
  function costHttpError(status) {
    if (status === 401) return 'HTTP 401：登录状态无效，请检查登录。';
    if (status === 403) return 'HTTP 403：服务器拒绝访问；本次费用未知。';
    if (status === 404) return 'HTTP 404：未找到当前会话的费用记录。';
    if (status === 429) return 'HTTP 429：请求受限，请稍后手动刷新。';
    if (status >= 500) return 'HTTP ' + status + '：服务暂时不可用，请稍后刷新。';
    return 'HTTP ' + status + '：费用读取失败。';
  }
  function cancelCostRequest() {
    costView.generation++;
    if (costView.timeout !== null) clearTimeout(costView.timeout);
    costView.timeout = null;
    if (costView.controller) costView.controller.abort();
    costView.controller = null;
    costView.busy = false;
  }
  function syncCostSession() {
    const path = location.pathname;
    if (path === costView.lastPath) return;
    cancelCostRequest();
    costView.lastPath = path;
    costView.last = null;
    costView.err = null;
    costView.updatedAt = null;
    costView.status = currentSessionId() ? 'idle' : 'no-session';
  }
  async function readSessionCost(sid, signal) {
    const r = await nativeFetch(`/api/chat/${sid}/cost?includeSession=true`, { credentials: 'include', signal });
    if (!r.ok) {
      // Do not read or echo an error body's HTML, credentials or conversation content.
      if (r.body && typeof r.body.cancel === 'function') {
        try { await r.body.cancel(); } catch (_) {}
      }
      throw new Error(costHttpError(r.status));
    }
    const text = await r.text();
    let raw;
    try { raw = literalsAsStrings(JSON.parse(text)); }
    catch (_) { throw new Error('响应格式错误：不是有效 JSON；未显示原始响应。'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('响应格式错误：费用数据应为对象。');
    }
    return { sid, raw, text };
  }
  function ensureCostControls() {
    if (!panel || !panel.cost) return;
    const box = panel.cost.closest('.costbox');
    if (!box) return;
    if (!box.querySelector('.cost-lifecycle-style')) {
      const style = document.createElement('style');
      style.className = 'cost-lifecycle-style';
      style.textContent = `
        #__arena_agent_billing_panel__ .costbox .cost{max-height:260px;padding:10px 12px;border:1px solid var(--ab-line,#dbe3ed);border-left:3px solid var(--ab-accent,#3b6fd4);border-radius:9px;line-height:1.75;font-variant-numeric:tabular-nums;background:var(--ab-bg2,#f6f8fa);color:var(--ab-fg,#1f2937)}
        #__arena_agent_billing_panel__ .costbox .cost[data-state="error"]{border-left-color:var(--ab-bad,#b3261e)}
        #__arena_agent_billing_panel__ .costbox .cost[data-state="ready"]{border-left-color:var(--ab-ok,#0b6b4f)}
        #__arena_agent_billing_panel__ .costbox .cost[data-state="stopped"]{border-left-color:var(--ab-dim,#5b6675)}
        #__arena_agent_billing_panel__ .costbox .cost-controls{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:6px}
        #__arena_agent_billing_panel__ .costbox button.cost-toggle{margin:0;padding:4px 8px;border:1px solid var(--ab-line,#dbe3ed);background:var(--ab-bg2,#f6f8fa);color:var(--ab-fg,#1f2937)}
        #__arena_agent_billing_panel__ .costbox .cost-scope{font-size:10px;color:var(--ab-dim,#5b6675)}
        #__arena_agent_billing_panel__ .costbox button:focus-visible{outline:2px solid var(--ab-accent,#3b6fd4);outline-offset:2px}
        #__arena_agent_billing_panel__ .costbox button:disabled{opacity:.55;cursor:wait}
      `;
      box.appendChild(style);
    }
    let toggle = box.querySelector('.cost-toggle');
    if (!toggle) {
      const controls = document.createElement('div');
      controls.className = 'cost-controls';
      toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'cost-toggle';
      toggle.onclick = () => costView.running ? stopCostReadout() : startCostReadout();
      const note = document.createElement('span');
      note.className = 'cost-scope';
      note.textContent = '仅控制费用更新，不控制筛选或全局监听';
      controls.append(toggle, note); box.appendChild(controls);
    }
    toggle.textContent = costView.running ? '停止费用更新' : '恢复费用更新';
    toggle.setAttribute('aria-pressed', String(costView.running));
    panel.cost.setAttribute('role', 'status');
    panel.cost.setAttribute('aria-live', 'polite');
    panel.cost.setAttribute('aria-atomic', 'true');
    panel.cost.setAttribute('aria-busy', String(costView.busy));
    if (panel.refresh) {
      panel.refresh.disabled = costView.busy;
      panel.refresh.textContent = costView.busy ? '读取中…' : '刷新';
      panel.refresh.title = '只刷新本次费用；停止时不会重新启动自动更新';
    }
  }
  function renderCost() {
    if (!panel || !panel.cost) return;
    ensureCostControls();
    const sid = currentSessionId();
    const last = costView.last && costView.last.sid === sid ? costView.last : null;
    const err = costView.lastPath === location.pathname ? costView.err : null;
    // 保留原恢复控件的可见性判断，不调用或改变其权限逻辑。
    if (panel.restore) panel.restore.hidden = !(err && /\b403\b/.test(err));
    const state = !sid ? 'no-session' : costView.busy ? 'loading' : err ? 'error'
      : !costView.running ? 'stopped' : last ? 'ready' : 'idle';
    const labels = { 'no-session': '无会话', loading: '读取中', error: '加载失败', stopped: '自动更新已停止', ready: '已读取', idle: '尚未读取' };
    panel.cost.dataset.state = state;
    const lines = ['费用 · ' + labels[state]];
    if (!sid) lines.push('请打开具体的 Agent 会话；没有会话不表示费用为零。');
    else {
      if (err) lines.push(err);
      if (!last) lines.push('实际成本：未知\n用户扣费：未知');
      else {
        const s = last.raw.session || {}, a = s.aggregate || {}, act = a.actual || {};
        if (state === 'error' || state === 'loading' || state === 'stopped') lines.push('以下为上次成功读数，可能已过期。');
        lines.push('实际成本  ' + costAmount(act.totalCostUsd),
          '用户扣费  ' + costAmount(a.totalChargedUsd),
          'Credits  ' + show(a.totalChargedCredits),
          '────────────',
          '缓存写  ' + costAmount(act.cacheWriteTokensCostUsd),
          '输出      ' + costAmount(act.outputTokensCostUsd),
          '缓存读  ' + costAmount(act.cacheReadTokensCostUsd),
          '输入      ' + costAmount(act.inputTokensCostUsd),
          '────────────',
          '消息 ' + show(s.messageCount) + ' · 策略 ' + show(a.pricingStrategy),
          '倍率 cm=' + show(a.costMultiplier) + ' mm=' + show(a.marginMultiplier),
          '成功读取 ' + new Date(costView.updatedAt).toLocaleTimeString(),
          '会话 ' + last.sid);
        if (act.isLongContext === true) lines.push('服务端标记：长上下文');
        if (act.isFallback === true) lines.push('服务端标记：回退计价');
      }
      if (document.visibilityState !== 'visible' && costView.running) lines.push('页面隐藏：费用更新已暂停。');
    }
    lines.push('未提供 ≠ 0；零费用仅表示该字段的服务端读数。');
    panel.cost.textContent = lines.join('\n');
  }
  async function refreshCost(manual) {
    syncCostSession();
    if (costView.busy) return false;
    const sid = currentSessionId();
    if (!sid) { costView.status = 'no-session'; renderCost(); if (manual) notify('没有会话可读取'); return false; }
    const generation = ++costView.generation;
    const controller = new AbortController();
    costView.controller = controller;
    costView.busy = true;
    costView.status = 'loading';
    let timedOut = false, success = false;
    costView.timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    renderCost();
    try {
      const result = await readSessionCost(sid, controller.signal);
      if (generation !== costView.generation || controller.signal.aborted || currentSessionId() !== sid) return false;
      costView.last = result;
      costView.updatedAt = Date.now();
      costView.err = null;
      costView.status = 'ready';
      setIdentifySource(sid, result.text);
      success = true;
    } catch (e) {
      if (generation !== costView.generation || currentSessionId() !== sid) return false;
      costView.err = timedOut ? '请求超时（15 秒），请稍后刷新。'
        : e instanceof TypeError ? '网络连接失败，请检查网络后刷新。'
        : e && /^(HTTP |响应格式错误)/.test(e.message) ? e.message : '费用读取失败，请稍后刷新。';
      costView.status = 'error';
    } finally {
      if (generation === costView.generation) {
        if (costView.timeout !== null) clearTimeout(costView.timeout);
        costView.timeout = null;
        costView.controller = null;
        costView.busy = false;
        renderCost();
        if (success) refreshIdentify();
      }
    }
    if (manual && generation === costView.generation && currentSessionId() === sid) {
      notify(success ? '费用读数已刷新' : '费用读取失败，请查看费用面板');
    }
    return success;
  }
  function onCostVisibility() {
    if (document.visibilityState !== 'visible') {
      cancelCostRequest(); renderCost();
    }
    // 恢复可见后等下一次固定周期，不增加请求频率。
  }
  function onCostNavigation() {
    syncCostSession(); renderCost();
  }
  function onCostPageHide() { stopCostReadout(); }
  function stopCostReadout() {
    costView.running = false;
    if (costView.timer !== null) clearInterval(costView.timer);
    costView.timer = null;
    cancelCostRequest();
    if (costView.listeners) {
      document.removeEventListener('visibilitychange', onCostVisibility);
      window.removeEventListener('popstate', onCostNavigation);
      window.removeEventListener('pagehide', onCostPageHide);
      costView.listeners = false;
    }
    costView.status = 'stopped';
    renderCost();
  }
  function startCostReadout() {
    if (costView.running) { renderCost(); return; }
    costView.running = true;
    syncCostSession();
    document.addEventListener('visibilitychange', onCostVisibility);
    window.addEventListener('popstate', onCostNavigation);
    window.addEventListener('pagehide', onCostPageHide);
    costView.listeners = true;
    if (document.visibilityState === 'visible') void refreshCost();
    else renderCost();
    costView.timer = setInterval(() => {
      if (!costView.running) return;
      syncCostSession();
      if (document.visibilityState !== 'visible') { renderCost(); return; }
      void refreshCost();
    }, 15000);
  }

  function bootstrap() {
    installNetworkHooks();
    // 不在 battle/首页写 feature flag，也不注入自动化面板；油猴脚本只服务 Agent。
    if (!/^\/agent(?:\/|$)/.test(location.pathname)) return;
    enableBillingFlag();
    automationWatchDomThinking();
    const ready = () => { if (!document.getElementById('__arena_agent_billing_panel__')) createPanel(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
    startCostReadout();
    watchTimer = setInterval(() => {
      if (!run.owned || run.sessionId || run.phase !== 'PROBING') return;
      const sid = currentSessionId();
      if (sid && sid !== run.previousSessionId) {
        run.sessionId = sid; run.owned = true; save();
      }
    }, 500);
  }

  window.__ARENA_AGENT_BILLING__ = {
    config,
    run,
    start: startAutomation,
    stop: stopAutomation,
    scanThoughtSignals,
    // ★ 思考判据（2026-10-11 起 = 页面 DOM，不再是流量）：真机上可直接复核
    //   「页面此刻算不算正在思考」以及手动跑一次扫描。
    thinking: {
      domLabel: automationDomThinkingLabel,
      sweep: automationSweepDomThinking,
      watch: automationWatchDomThinking,
    },
    classify,
    enableBillingFlag,
    // 内嵌内核识别（与 CLI 同源）：只读接口 + 纯函数，便于在页面控制台复核与自动化测试。
    identify: {
      build: __IDENTIFY_BUILD__,
      bundle: __IDENTIFY_BUNDLE__,
      catalog: IDENTIFY_CATALOG,
      catalogSize: IDENTIFY_CATALOG.length,
      report: identifyReport,
      render: renderIdentifyText,
      sanitize: sanitizeCostForExport,
      catalogGroup: identifyCatalogGroup,
      fingerprint: identifyFingerprint,
      refresh: refreshIdentify,
      state: identifyView,
      export: exportSessionCost,
      exportText: buildCostExportText,
      setSource: setIdentifySource,
    },
    // 供离线测试注入最小 DOM 桩后直接调面板渲染（T2 的 parity/DOM 套件用）。
    __test__: {
      createPanel,
      renderIdentify,
      renderCost,
      identifyReport,
      renderIdentifyText,
      sanitizeCostForExport,
      buildCostExportText,
      catalogFromBundle: identifyBundleCatalog,
      build: __IDENTIFY_BUILD__,
      bundle: __IDENTIFY_BUNDLE__,
      setPanel(p) { panel = p; },
      setIdentifySource,
      getPanel() { return panel; },
    },
  };
  bootstrap();
})();
