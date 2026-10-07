// JSDoc 必須ルール（jsdoc/require-jsdoc）の検出対象を固定する fixture。
// 検出されるべき宣言の直前の行に `expect-jsdoc` の印を置く。印の無い宣言は検出されてはならない。
// 印を宣言と同じ行の末尾に置くと、Prettier がブロック内へ移して行がずれるため、直前の行に置く。
// 検査は test/lint/jsdoc.test.ts が行う。通常の Lint の対象からは外している（eslint.config.js）。

// expect-jsdoc
export function exportedFn(a: string): string {
  return a;
}

// expect-jsdoc
export default function defaultFn(): void {}

function internalFn(): void {}

// expect-jsdoc
export const EXPORTED_CONST = 1;

const INTERNAL_CONST = 2;

// expect-jsdoc
export type ExportedType = { id: string };

type InternalType = { id: string };

// expect-jsdoc
export interface ExportedInterface {
  id: string;
}

// expect-jsdoc
export class ExportedService {
  constructor(private readonly prefix: string) {}

  // expect-jsdoc
  findAll(): string[] {
    return [this.prefix];
  }

  // expect-jsdoc
  protected findOne(): string {
    return this.prefix;
  }

  private helper(): void {}
}

class InternalService {
  run(): void {}
}

/**
 * JSDoc を付けた export 関数。検出されてはならない。
 *
 * @param a - 入力
 * @returns 入力そのまま
 */
export function documentedFn(a: string): string {
  return a;
}
