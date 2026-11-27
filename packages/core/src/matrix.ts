import type { Matrix } from './model';

/** 返回 a∘b：先应用 b，再应用 a */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** 求逆；矩阵不可逆时返回 null */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    m[3] * inv,
    -m[1] * inv,
    -m[2] * inv,
    m[0] * inv,
    (m[2] * m[5] - m[3] * m[4]) * inv,
    (m[1] * m[4] - m[0] * m[5]) * inv,
  ];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/** 绕原点旋转。角度为弧度，正方向是屏幕上的顺时针（y 轴朝下） */
export function rotation(radians: number): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

/** 把一个以原点为中心的变换改成以 (cx, cy) 为中心 */
export function around(m: Matrix, cx: number, cy: number): Matrix {
  return multiply(translation(cx, cy), multiply(m, translation(-cx, -cy)));
}

/** 矩阵里包含的旋转角，弧度，范围 (-π, π] */
export function rotationOf(m: Matrix): number {
  return Math.atan2(m[1], m[0]);
}

/** 在父坐标系里把节点平移 (dx, dy) */
export function translated(m: Matrix, dx: number, dy: number): Matrix {
  return [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 只变换方向向量，不带平移 */
export function applyToVector(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function isTranslationOnly(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
}
