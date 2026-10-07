// JSDoc 必須ルール（jsdoc/require-jsdoc）の検出対象を固定する fixture。
// 検出されるべき宣言の直前の行に `expect-jsdoc` の印を置く。印の無い宣言は検出されてはならない。
// 対象の構文ごとに「JSDoc 無し（検出される）」と「JSDoc 付き（検出されない）」の両方を置く。
// 片方だけだと、常に報告するセレクタや何も報告しないセレクタを見逃す。
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

// ---- 以下は JSDoc 付き。すべて検出されてはならない ----

/**
 * JSDoc を付けた export 関数。
 *
 * @param a - 入力
 * @returns 入力そのまま
 */
export function documentedFn(a: string): string {
  return a;
}

/** JSDoc を付けた export 定数（単一行） */
export const DOCUMENTED_CONST = 1;

/** JSDoc を付けた export 定数（複数行の初期化子。中に JSDoc を含む） */
export const DOCUMENTED_MULTILINE = String(
  /** 引数の説明 */
  1,
);

/** JSDoc を付けた export 型 */
export type DocumentedType = { id: string };

/** JSDoc を付けた export interface */
export interface DocumentedInterface {
  id: string;
}

/** JSDoc を付けた export クラス */
export class DocumentedService {
  /**
   * JSDoc を付けた公開メソッド。
   *
   * @returns 空配列
   */
  findAll(): string[] {
    return [];
  }
}
