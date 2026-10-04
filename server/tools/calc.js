/**
 * A calculator the assistant can actually rely on.
 *
 * Getting sums wrong is the oldest failure a language model has, and the one
 * that costs most in a report: a total that does not add up puts every number
 * beside it in doubt. So arithmetic is done here, by evaluating the expression,
 * rather than recalled.
 *
 * **This is a parser, not a code runner, and that is a security decision.** The
 * obvious implementation is `node:vm`, and it would be wrong: `vm` is an
 * isolation boundary for trusted code, not a security sandbox — the constructor
 * chain escapes it, and on the other side sits `process.env`, which on this
 * deployment holds the key every account's stored credentials are encrypted
 * under. The model reads web pages, and a web page can tell it what to compute
 * next, so the input here is not trustworthy. A recursive-descent parser over
 * numbers, operators and a fixed function table has nothing to escape from: the
 * worst a hostile expression can do is fail to parse.
 */

/** At least `n` arguments, or a sentence that says which function wanted them. */
const need = (name, xs, n) => {
  if (xs.length < n) throw new Error(`${name} needs at least ${n} argument(s).`);
  return xs;
};

/** n! for a whole number from 0 to 170 — past that it is not a finite number. */
const factorial = (n) => {
  if (!Number.isInteger(n) || n < 0) throw new Error('A factorial is of a whole number from 0 up.');
  if (n > 170) throw new Error('That factorial is too large to be a finite number.');
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
};

const variance = (xs, sample) => {
  if (xs.length < (sample ? 2 : 1)) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
};

/*
 * Time value of money, with Excel's argument order and sign convention — cash
 * paid out is negative — because that is the form a finance textbook, a
 * spreadsheet and the person asking all use. `type` 1 means payments at the
 * start of each period.
 */
const fvOf = (rate, nper, pmt, pv = 0, type = 0) =>
  rate === 0 ? -(pv + pmt * nper) : -(pv * (1 + rate) ** nper + (pmt * (1 + rate * type) * ((1 + rate) ** nper - 1)) / rate);
const pvOf = (rate, nper, pmt, fv = 0, type = 0) =>
  rate === 0 ? -(fv + pmt * nper) : -(fv + (pmt * (1 + rate * type) * ((1 + rate) ** nper - 1)) / rate) / (1 + rate) ** nper;
const pmtOf = (rate, nper, pv, fv = 0, type = 0) => {
  if (nper === 0) throw new Error('pmt needs a number of periods other than 0.');
  return rate === 0
    ? -(pv + fv) / nper
    : -(rate * (fv + pv * (1 + rate) ** nper)) / ((1 + rate * type) * ((1 + rate) ** nper - 1));
};
const npvOf = (rate, flows) => flows.reduce((total, cf, i) => total + cf / (1 + rate) ** (i + 1), 0);

/**
 * The rate at which these cash flows are worth nothing today.
 *
 * Newton's method from a 10% guess, and bisection when Newton wanders — a
 * schedule with one sign change has exactly one answer above -100%, and that
 * is the one returned.
 */
function irrOf(flows) {
  if (!flows.some((v) => v > 0) || !flows.some((v) => v < 0)) {
    throw new Error('irr needs at least one negative and one positive cash flow.');
  }
  const at = (r) => flows.reduce((t, cf, i) => t + cf / (1 + r) ** i, 0);
  let r = 0.1;
  for (let i = 0; i < 100; i += 1) {
    const f = at(r);
    const d = flows.reduce((t, cf, k) => t - (k * cf) / (1 + r) ** (k + 1), 0);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (Math.abs(next - r) < 1e-12) return next;
    if (next <= -0.999999) break;
    r = next;
  }
  let lo = -0.999999;
  let hi = 10;
  if (Math.sign(at(lo)) === Math.sign(at(hi))) throw new Error('irr found no rate that brings these cash flows to zero.');
  for (let i = 0; i < 300; i += 1) {
    const mid = (lo + hi) / 2;
    if (Math.sign(at(mid)) === Math.sign(at(lo))) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Named values. A bare name that is not one of these and not a function is refused. */
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

const FUNCTIONS = {
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  avg: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0),
  mean: (xs) => FUNCTIONS.avg(xs),
  median: (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
  count: (xs) => xs.length,
  abs: (xs) => Math.abs(xs[0]),
  sqrt: (xs) => Math.sqrt(xs[0]),
  round: (xs) => {
    const places = xs.length > 1 ? Math.max(0, Math.min(10, Math.trunc(xs[1]))) : 0;
    const factor = 10 ** places;
    return Math.round(xs[0] * factor) / factor;
  },
  stdev: (xs) => Math.sqrt(variance(xs, true)),
  stdevp: (xs) => Math.sqrt(variance(xs, false)),
  var: (xs) => variance(xs, true),
  varp: (xs) => variance(xs, false),
  product: (xs) => xs.reduce((a, b) => a * b, 1),
  geomean: (xs) => {
    if (!xs.length || xs.some((x) => x <= 0)) throw new Error('geomean needs positive numbers.');
    return Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length);
  },
  pow: (xs) => need('pow', xs, 2)[0] ** xs[1],
  exp: (xs) => Math.exp(need('exp', xs, 1)[0]),
  ln: (xs) => Math.log(need('ln', xs, 1)[0]),
  // Excel's LOG: base 10 unless a base is given.
  log: (xs) => Math.log(need('log', xs, 1)[0]) / Math.log(xs.length > 1 ? xs[1] : 10),
  log10: (xs) => Math.log10(need('log10', xs, 1)[0]),
  log2: (xs) => Math.log2(need('log2', xs, 1)[0]),
  cbrt: (xs) => Math.cbrt(need('cbrt', xs, 1)[0]),
  floor: (xs) => Math.floor(need('floor', xs, 1)[0]),
  ceil: (xs) => Math.ceil(need('ceil', xs, 1)[0]),
  trunc: (xs) => Math.trunc(need('trunc', xs, 1)[0]),
  sign: (xs) => Math.sign(need('sign', xs, 1)[0]),
  mod: (xs) => {
    need('mod', xs, 2);
    if (xs[1] === 0) throw new Error('mod by zero has no answer.');
    // The sign of the divisor, as a spreadsheet does it: mod(-1, 3) is 2.
    return xs[0] - xs[1] * Math.floor(xs[0] / xs[1]);
  },
  hypot: (xs) => Math.hypot(...xs),
  sin: (xs) => Math.sin(need('sin', xs, 1)[0]),
  cos: (xs) => Math.cos(need('cos', xs, 1)[0]),
  tan: (xs) => Math.tan(need('tan', xs, 1)[0]),
  asin: (xs) => Math.asin(need('asin', xs, 1)[0]),
  acos: (xs) => Math.acos(need('acos', xs, 1)[0]),
  atan: (xs) => Math.atan(need('atan', xs, 1)[0]),
  fact: (xs) => factorial(need('fact', xs, 1)[0]),
  comb: (xs) => {
    const [n, k] = need('comb', xs, 2);
    return k < 0 || k > n ? 0 : Math.round(factorial(n) / (factorial(k) * factorial(n - k)));
  },
  perm: (xs) => {
    const [n, k] = need('perm', xs, 2);
    return k < 0 || k > n ? 0 : Math.round(factorial(n) / factorial(n - k));
  },
  // Finance, in Excel's argument order: fv(rate, nper, pmt, [pv], [type]) and so on.
  fv: (xs) => fvOf(...need('fv', xs, 3)),
  pv: (xs) => pvOf(...need('pv', xs, 3)),
  pmt: (xs) => pmtOf(...need('pmt', xs, 3)),
  npv: (xs) => npvOf(need('npv', xs, 2)[0], xs.slice(1)),
  irr: (xs) => irrOf(need('irr', xs, 2)),
  // Effective annual rate from a nominal one compounded `n` times a year.
  effect: (xs) => {
    const [nominal, n] = need('effect', xs, 2);
    return (1 + nominal / n) ** n - 1;
  },
};
FUNCTIONS.average = FUNCTIONS.avg;
FUNCTIONS.factorial = FUNCTIONS.fact;
FUNCTIONS.power = FUNCTIONS.pow;

/**
 * The way people and models actually write arithmetic, read as the plain form.
 *
 * `×`, `÷`, `·`, the typographic minus, `**` for a power and a leading `=` as in
 * a spreadsheet cell all mean exactly one thing, and refusing them turned a
 * correct sum into a failed step and a retry.
 */
function normalise(src) {
  return src
    .replace(/^\s*=+/, '')
    .replace(/=+\s*$/, '')
    .replace(/[×✕✖∗]/g, '*')
    .replace(/[·⋅]/g, '*')
    .replace(/[÷∶]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/\*\*/g, '^')
    .replace(/π/g, 'pi')
    .replace(/√/g, ' sqrt ')
    .replace(/[{]/g, '(')
    .replace(/[}]/g, ')');
}

/** Numbers, operators, brackets, commas and bare function names. Nothing else. */
function tokenise(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!match) throw new Error(`"${src.slice(i, i + 8)}" is not a number this can read.`);
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
      tokens.push({ type: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    if ('+-*/^(),[]%!'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    // Everything else — a dot after a name, a quote, a semicolon — is the shape
    // of code rather than of arithmetic, and is refused by name.
    throw new Error(`"${ch}" has no meaning in a calculation. Use numbers, + - * / ^ % ! ( ), lists and the named functions.`);
  }
  return tokens;
}

/**
 * expression := term (('+' | '-') term)*
 * term       := power (('*' | '/' | '%') power | power)*   — a bare `power` is implicit ×
 * power      := unary ('^' power)?      — right-associative
 * unary      := '-' unary | postfix
 * postfix    := primary ('!' | '%')*      — `%` here is "per cent"
 * primary    := number | constant | name '(' args ')' | name unary | '(' expression ')'
 *
 * Implicit multiplication is the one people and models both write without
 * noticing — `(1.5)(1.1)`, `2(3 + 4)`, `2pi` — and refusing it failed a whole
 * portfolio-variance step on a missing `*` that every reader would have supplied.
 */
function parser(tokens, source) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    if (!tokens[pos] || tokens[pos].type !== type) {
      throw new Error(`Expected ${type} in "${source}" — the expression is incomplete or mis-bracketed.`);
    }
    return tokens[pos++];
  };

  function list() {
    take('[');
    const items = [];
    if (peek()?.type !== ']') {
      items.push(expression());
      while (peek()?.type === ',') {
        pos += 1;
        items.push(expression());
      }
    }
    take(']');
    return items;
  }

  function primary() {
    const t = peek();
    if (!t) throw new Error(`"${source}" ends before it is finished.`);

    if (t.type === 'number') {
      pos += 1;
      return t.value;
    }
    if (t.type === '(') {
      pos += 1;
      const value = expression();
      take(')');
      return value;
    }
    if (t.type === '[') {
      // A bare list has no value of its own; it only makes sense inside a call.
      throw new Error('A list on its own is not a number. Use it inside a function, like sum([1, 2, 3]).');
    }
    if (t.type === 'name') {
      pos += 1;
      const key = t.value.toLowerCase();
      const fn = Object.hasOwn(FUNCTIONS, key) ? FUNCTIONS[key] : null;
      if (!fn) {
        if (Object.hasOwn(CONSTANTS, key)) return CONSTANTS[key];
        throw new Error(
          `"${t.value}" is not a function this knows. Available: ${Object.keys(FUNCTIONS).join(', ')}; constants ${Object.keys(CONSTANTS).join(', ')}.`,
        );
      }
      // `sqrt 9`, as `√9` arrives: one argument, without brackets.
      if (peek()?.type !== '(') return fn([unary()]);
      take('(');
      /** Arguments flatten, so sum([1,2]) and sum(1,2) both work. */
      const args = [];
      if (peek()?.type !== ')') {
        const push = () => {
          if (peek()?.type === '[') args.push(...list());
          else args.push(expression());
        };
        push();
        while (peek()?.type === ',') {
          pos += 1;
          push();
        }
      }
      take(')');
      return fn(args);
    }
    throw new Error(`"${source}" has something where a number should be.`);
  }

  /** Whether the token at `at` can begin a number — what makes juxtaposition a product. */
  const starts = (at) => ['number', 'name', '('].includes(tokens[at]?.type);

  function postfix() {
    let value = primary();
    for (;;) {
      const next = peek()?.type;
      if (next === '!') {
        pos += 1;
        value = factorial(value);
      } else if (next === '%' && !starts(pos + 1)) {
        // "15%" is 0.15. A `%` with a number after it is the remainder instead.
        pos += 1;
        value /= 100;
      } else {
        return value;
      }
    }
  }

  function unary() {
    if (peek()?.type === '-') {
      pos += 1;
      return -unary();
    }
    if (peek()?.type === '+') {
      pos += 1;
      return unary();
    }
    return postfix();
  }

  function power() {
    const base = unary();
    if (peek()?.type === '^') {
      pos += 1;
      return base ** power();
    }
    return base;
  }

  function term() {
    let value = power();
    for (;;) {
      const type = peek()?.type;
      let op;
      if (type === '*' || type === '/' || type === '%') op = tokens[pos++].type;
      else if (starts(pos)) op = '*';
      else return value;
      const right = power();
      if ((op === '/' || op === '%') && right === 0) {
        throw new Error('That divides by zero, which has no answer. Check the denominator.');
      }
      value = op === '*' ? value * right : op === '/' ? value / right : value - right * Math.floor(value / right);
    }
  }

  function expression() {
    let value = term();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const op = tokens[pos++].type;
      value = op === '+' ? value + term() : value - term();
    }
    return value;
  }

  const result = expression();
  if (pos < tokens.length) {
    throw new Error(`"${source}" has something left over after the expression — check the brackets and operators.`);
  }
  return result;
}

/**
 * @returns { value, expression } — the answer, and the expression it came from,
 *   so a reader can check the working rather than taking the number on trust.
 */
export function evaluate(source) {
  const src = String(source ?? '').trim();
  if (!src) throw new Error('There is nothing to calculate.');
  if (src.length > 2000) throw new Error('That expression is too long to be arithmetic.');

  const value = parser(tokenise(normalise(src)), src);
  if (!Number.isFinite(value)) {
    throw new Error('That does not come out to a finite number. Check for a division by zero or an overflow.');
  }
  return { value, expression: src };
}

/** Exposed so the tool description can list what is available without drifting. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS);
