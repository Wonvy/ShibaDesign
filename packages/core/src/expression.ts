/**
 * 数字输入框里的算式：`100+20`、`(10+5)*2`、`*2`、`/3`、`+10`、`50%`、`+10%`。
 * 开头是 + * / 时相对现在的值算（`*2` 是现在的两倍）；`%` 跟在数后面时是现在的值的百分之几。
 * 只认数字、加减乘除、括号和百分号，不执行任何代码。算不出来（格式不对、除以 0）时返回 null
 */
export function evaluateNumberInput(input: string, current: number): number | null {
  const text = input.trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/，/g, '.');
  if (text === '') return null;
  // 开头是运算符：相对现在的值
  const relative = /^[+*/]/.test(text);
  const source = relative ? `${current}${text}` : text;
  let pos = 0;

  const peek = (): string => source[pos] ?? '';
  const skip = (): void => {
    while (peek() === ' ') pos++;
  };

  function primary(): number | null {
    skip();
    const c = peek();
    if (c === '(') {
      pos++;
      const value = sum();
      skip();
      if (peek() !== ')' || value === null) return null;
      pos++;
      return value;
    }
    if (c === '-' || c === '+') {
      pos++;
      const value = primary();
      return value === null ? null : c === '-' ? -value : value;
    }
    const match = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(source.slice(pos));
    if (!match) return null;
    pos += match[0].length;
    let value = Number(match[0]);
    skip();
    if (peek() === '%') {
      pos++;
      value = (current * value) / 100;
    }
    return value;
  }

  function product(): number | null {
    let value = primary();
    for (;;) {
      skip();
      const op = peek();
      if ((op !== '*' && op !== '/') || value === null) return value;
      pos++;
      const right = primary();
      if (right === null) return null;
      if (op === '/' && right === 0) return null;
      value = op === '*' ? value * right : value / right;
    }
  }

  function sum(): number | null {
    let value = product();
    for (;;) {
      skip();
      const op = peek();
      if ((op !== '+' && op !== '-') || value === null) return value;
      pos++;
      const right = product();
      if (right === null) return null;
      value = op === '+' ? value + right : value - right;
    }
  }

  const result = sum();
  skip();
  if (result === null || pos !== source.length || !Number.isFinite(result)) return null;
  return result;
}
