---
description: JSDoc（TSDoc）ドキュメンテーションコメント規約 — TypeScript の公開シンボル・型メンバーに必須
globs: "functions/src/**,infra/cdk/**"
---

# JSDoc 規約（TypeScript）

TypeScript コードの**公開シンボル**には JSDoc（TSDoc 記法）を**必須**とする。TypeDoc によるドキュメント生成を前提とする。

## 必須対象（公開シンボル）

以下の公開シンボルには JSDoc を必ず付与する:

- `export` された関数・クラス・メソッド・型（`type` / `interface`）・定数
- **型のメンバー**（`type` / `interface` の各プロパティ、union リテラルの各値）— 次節参照
- React/Vue コンポーネントの **props 型**（各プロパティに説明）
- カスタムフック（`useXxx`）・composable（`useXxx`）と、**その戻り値の各メンバー**
- **store の state / action**（Zustand・Pinia 等）、**Context / provide-inject の value の各メンバー** — 後述「状態・ロジック層のコメント」参照
- 公開 API のハンドラー・サービスメソッド

**任意対象**: `export` されない内部関数、コンポーネント内に閉じた `useState`・ハンドラ関数、および処理が自明な 1 行ユーティリティ。ただし意図が非自明なものは内部でも付与する（「混乱テスト」）。

## 型定義のコメント（型本体 + メンバー）

`type` / `interface` は**型本体と各メンバーの両方**にコメントを付ける。型シグネチャは「形」しか語らないため、**意味・単位・制約・状態の定義**はコメントでしか残せない。

- **型本体**: 1 行目に「**何を表す型か**」を書く。どの層のものか（API レスポンス / ドメインエンティティ / props）も併記すると読み手が迷わない。
- **各プロパティ**: 型名から読み取れない情報を書く。特に以下は必須:
  - **単位**（`durationMs` がミリ秒か秒か、`amount` が円か銭か）
  - **`null` / `undefined` / 省略の意味**（「未設定」なのか「該当なし」なのか）
  - **制約・不変条件**（値域、フォーマット、他プロパティとの関係）
  - 自明なプロパティ（`id` 等）は省略してよい。**書くことがない項目に埋め草コメントを付けない**。
- **union リテラル**: 各値が**どの状態を指すか**を個別に書く。値の文字列そのものからは業務上の意味が読めない。
- コロケーションした非 `export` の型も、意味が非自明なら同様に付ける（判断は「混乱テスト」に従う）。

```ts
/**
 * タスクの進行状態。ワークフロー上の遷移は todo → doing → done の一方向のみ。
 */
export type TaskStatus =
  /** 未着手。担当者未割り当てを含む */
  | 'todo'
  /** 着手済み。担当者が必ず 1 名紐づく */
  | 'doing'
  /** 完了。以降は編集不可（アーカイブ対象） */
  | 'done';

/**
 * タスクのドメインエンティティ。API レスポンスと画面表示の共通表現。
 */
export type Task = {
  id: string;
  /** 表示用タイトル。前後の空白は除去済み・最大 120 文字 */
  title: string;
  status: TaskStatus;
  /** 期限（ISO 8601 文字列）。`null` は「期限なし」であり「未入力」ではない */
  dueDate: string | null;
  /** 見積もり作業時間（**分**）。未見積もりは `undefined` */
  estimatedMinutes?: number;
};
```

## 状態・ロジック層のコメント（store / context / hooks）

store（Zustand 等）・Context の value・カスタムフックの戻り値は、**定義ファイルを開かずに利用される**。したがって「値が何を意味するか」「関数が何を変えるか」はコメントでしか伝わらない。

### 必須ラインは「参照範囲」で決める

型定義の配置（`typescript.md`）と同じ軸を使う。

| 対象 | コメント |
|---|---|
| **ファイルを越えて使われる** — store の state / action、Context value の各メンバー、カスタムフックの戻り値、`export` された関数 | **必須** |
| **ファイル内に閉じる** — コンポーネント内の `useState`・ハンドラ関数・ローカル変数 | **条件付き**（「なぜ」が非自明なときのみ。次節「混乱テスト」に従う） |

コンポーネント内部まで一律必須にしない。`setIsOpen` に「isOpen をセットする」と書くような**埋め草が量産され、本当に重要なコメントが埋もれる**ため。

### 型を先に定義してコメントを型側に置く

store やフック戻り値を**インラインのオブジェクトリテラル**で書くと、その中身は「宣言」ではなく「式」になるため、JSDoc 規約も Lint も効かない。**先に型を定義し、コメントは型のメンバーに書く**。こうすると前節「型定義のコメント」の規約がそのまま効く。

```ts
// ❌ インライン定義 — コメントの置き場がなく、Lint も拾えない
export const useTaskStore = create((set) => ({
  filter: 'all',
  setFilter: (f) => set({ filter: f }),
}));

// ✅ 型を先に定義 → 型メンバーのコメント規約と Lint が効く
/** タスク一覧画面の絞り込み状態。URL クエリとは同期しない（画面内に閉じる）。 */
type TaskStore = {
  /** 現在の絞り込み条件。初期値は 'all'（永続化しない） */
  filter: TaskFilter;
  /** 絞り込みを変更する。一覧の再取得は走らない（クライアント側フィルタ） */
  setFilter: (filter: TaskFilter) => void;
};

export const useTaskStore = create<TaskStore>((set) => ({
  filter: 'all',
  setFilter: (filter) => set({ filter }),
}));
```

**setup 構文のストア・composable**（Pinia の `defineStore('x', () => {...})` 等）では、`ref` や関数が**それぞれ独立した宣言**になっている。この場合は戻り値型を無理に定義せず、**各宣言に直接 JSDoc を付ける**（宣言なので JSDoc も Lint も自然に効く）。

```ts
export const useTaskStore = defineStore('task', () => {
  /** 現在の絞り込み条件。初期値は 'all'（永続化しない） */
  const filter = ref<TaskFilter>('all');

  /** 絞り込みを変更する。一覧の再取得は走らない（クライアント側フィルタ） */
  function setFilter(next: TaskFilter) {
    filter.value = next;
  }

  return { filter, setFilter };
});
```

同じ手をカスタムフックの戻り値にも使う。**戻り値型を明示**すれば、各メンバーの説明が型側に集まる。

```ts
/** タスク一覧の取得と絞り込みを扱う。 */
type UseTaskListResult = {
  /** 絞り込み適用後のタスク。読み込み中は空配列（`undefined` にはしない） */
  tasks: Task[];
  /** 初回取得中のみ true。再取得中は false のまま（画面のちらつき防止） */
  isLoading: boolean;
  /** 再取得する。実行中に呼んでも多重リクエストは発生しない */
  refetch: () => Promise<void>;
};

export function useTaskList(filter: TaskFilter): UseTaskListResult { /* ... */ }
```

### 書くべき内容

state / action に書くのは**シグネチャから読めない情報**に限る。

- **その値がいつ変わるか / 誰が変えるか**（「ログアウト時にリセットされる」）
- **初期値・空値の意味**（「空配列は『0 件』であり『未取得』ではない」）
- **副作用の有無**（「この action は API を呼ばない。永続化は `persist` ミドルウェア任せ」）
- **他の値との関係・不変条件**（「`selectedId` は必ず `tasks` に含まれる ID」）

## 混乱テスト（公開/内部・本番/テストを問わない）

判断軸は「public か否か」ではなく **「1 か月後の自分／他プロジェクト帰りの読み手が『これは何？なぜ？』となるか」**。なるなら、内部関数でもテストコードでも "why" を残す。

- **キャスト・回避策には "why" 必須**: `as unknown as` / `as any` / `@ts-ignore` / `@ts-expect-error` / マジック値 / 複雑な正規表現 / 明示的なワークアラウンド。**型を欺く・仕様を迂回する箇所は、その根拠（なぜ安全か／なぜ必要か）がコードから消える**ため、コメントが唯一の記録になる。
  - 例: テストダブルを `repo as unknown as Repository<Task>` で注入する場合、「ダブルは対象が実際に呼ぶメソッドだけの部分実装で、実型は構造的に大きいため二段キャストで隙間を埋める（実行時は使う分だけで足りる）」と残す。
- **テスト足場**（SUT ビルダー・複雑な fixture・非自明な mock）も、意図が読み取りにくいなら付ける。

## 記述ルール

- **型は書かない**: 型は TypeScript のシグネチャが唯一の真実（source of truth）。JSDoc に `{string}` 等の型ブレースを併記しない（二重管理・型ずれの原因になる）。JSDoc は**意図・意味・制約**を日本語で記述する。
- **要約行必須**: 1 行目にそのシンボルが「何をするか」を簡潔に書く。
- **`@param` 必須**: 全引数に `@param name - 説明` を記述する。オプション引数・デフォルト値の意味も明記する。
- **`@returns` 必須**: 戻り値がある場合は `@returns 説明` を記述する（`void` / JSX 返却のコンポーネントは省略可）。
- **`@throws` 必須**: 意図的に例外を投げる場合は `@throws {ErrorType} 発生条件` を記述する。
- **補助タグ（任意）**: `@example` `@deprecated` `@see` は必要に応じて使う。

## 例

```ts
/**
 * ユーザー ID から表示名を解決する。キャッシュに無ければ API を叩く。
 *
 * @param userId - 対象ユーザーの UUID
 * @param opts - 解決オプション（`force` 指定でキャッシュを無視）
 * @returns 表示名。ユーザーが存在しない場合は `null`
 * @throws {ApiError} API 通信に失敗した場合
 */
export async function resolveDisplayName(
  userId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  // ...
}
```

## Lint による強制（推奨）

公開シンボルへの JSDoc 欠落・`@param` / `@returns` 漏れを CI で検出する。**欠落の検出（`require-jsdoc`）は `eslint-plugin-jsdoc` にしか無い**ため、Linter によって読み込み方が変わる。

| Linter | 欠落の検出（`require-jsdoc`） | タグの検査（`require-param` / `require-returns` / `no-blank-blocks`） |
|---|---|---|
| ESLint | `eslint-plugin-jsdoc` | `eslint-plugin-jsdoc` |
| oxlint | `jsPlugins` で `eslint-plugin-jsdoc` を読み込む。**プラグイン名 `jsdoc` は組み込みが予約しているため、別名（例: `jsdoc-js`）を付ける** | 組み込みの `jsdoc` プラグイン（`require-jsdoc` だけが無い） |

TypeScript プロジェクトでは型ブレース系ルールを無効化する（`require-param-type` / `require-returns-type` を off）。

### 対象は `publicOnly` ではなく AST セレクタで指定する

**`publicOnly: true` に頼らない。** oxlint の `jsPlugins` 経由では、`publicOnly` が export されたクラスのメソッドを**エラーも出さずに取りこぼす**（同じ入力で ESLint は検出し、oxlint は検出しない）。export の有無をセレクタで明示すれば、どちらの Linter でも同じ結果になる。

```jsonc
// oxlint（.oxlintrc.json）。ESLint では同じオプションを jsdoc/require-jsdoc に渡す
{
  "jsPlugins": [{ "name": "jsdoc-js", "specifier": "eslint-plugin-jsdoc" }],
  "rules": {
    "jsdoc-js/require-jsdoc": ["error", {
      "enableFixer": false,
      "require": { "FunctionDeclaration": false },
      "contexts": [
        "ExportNamedDeclaration > FunctionDeclaration",
        "ExportDefaultDeclaration > FunctionDeclaration",
        "ExportNamedDeclaration > ClassDeclaration",
        "ExportDefaultDeclaration > ClassDeclaration",
        "ExportNamedDeclaration > ClassDeclaration > ClassBody > MethodDefinition[accessibility!='private'][kind!='constructor']",
        "ExportNamedDeclaration > TSTypeAliasDeclaration",
        "ExportNamedDeclaration > TSInterfaceDeclaration",
        "ExportNamedDeclaration:has(> VariableDeclaration)"
      ]
    }],
    "jsdoc/no-blank-blocks": "error",
    "jsdoc/require-param": "error",
    "jsdoc/require-returns": "error"
  }
}
```

- **`export const` は export 文そのもの（`ExportNamedDeclaration:has(> VariableDeclaration)`）を対象にする。** JSDoc は `export` 文の前に付くため、`ExportNamedDeclaration > VariableDeclaration` と子の宣言を指すと JSDoc が見えず、**JSDoc を付けた `export const` まで欠落と報告される**（ESLint + `eslint-plugin-jsdoc` 65 で確認）。関数・クラス・型は子を指しても JSDoc を見つけられるため、この差は構文ごとの fixture でしか気づけない（次節）。
- **`enableFixer: false` を必ず指定し、`no-blank-blocks` を `error` にする。** `require-jsdoc` は既定で自動修正が有効で、`--fix` が空の `/** */` を挿入して**欠落の検出を黙らせる**。
- **ルールは `error` か `off` のどちらかにする。** `warn` で段階導入しない（警告は放置されて検出装置として働かなくなる）。
- **型のメンバー（`TSPropertySignature`）は Lint で強制しない（`off`）。** 「自明なプロパティは省略してよい・書くことがない項目に埋め草コメントを付けない」方針と両立せず、`error` にすると埋め草を強いる。メンバーのコメントはレビューで見る。
- store・フック戻り値も、上記「型を先に定義する」に従えば型本体（`TSTypeAliasDeclaration`）として検出できる。**オブジェクトリテラルのプロパティを直接 Lint で強制しようとしない**（宣言ではないため誤検知が多く、実効性が低い）。

### 検出結果を回帰テストに固定する

oxlint の `jsPlugins` は互換層（alpha）であり、**バージョンの更新で検出結果が黙って変わり得る**（上記の `publicOnly` の取りこぼしもエラーにならない）。**検出されるべき行に印を付けた fixture を用意し、検出結果と印の行が一致することを CI で確かめる。**

```ts
// fixture: 検出されるべき宣言の直前の行に expect-jsdoc の印を置く。印の無い宣言は検出されてはならない
// expect-jsdoc
export function exportedFn(a: string): string {
  return a;
}

function internalFn(): void {}

// expect-jsdoc
export const EXPORTED_CONST = 1;

/** JSDoc 付き。検出されてはならない */
export const DOCUMENTED_CONST = 1;

// expect-jsdoc
export class TaskService {
  // expect-jsdoc
  findAll(): string[] {
    return [];
  }

  private helper(): void {}
}
```

- 印の行の集合と、Linter が報告した行の集合を比較し、**過不足があれば落とす**（検出漏れだけでなく、余計な検出も落とす）。
- fixture には、検出されるべきもの（export の関数・クラス・公開メソッド・型・定数）と、されてはならないもの（非 export・`private`・`constructor`）を**両方**入れる。片方だけでは、全部を検出する設定や何も検出しない設定を見逃す。
- **「両方」は対象の構文ごとに揃える。** 関数・クラス・公開メソッド・型・interface・定数のそれぞれに、「JSDoc 無し（検出される）」と「JSDoc 付き（検出されない）」を置く。全体で両方そろっていても、ある構文に JSDoc 付きのケースが無ければ、その構文だけ常に報告するセレクタを見逃す（上記 `export const` の誤りはこれで見逃された）。
- **印は宣言の直前の行に置く。** 宣言と同じ行の末尾に置くと、Formatter（Prettier）が `{ // 印` をブロック内へ移し、印と報告行がずれる。
- fixture は通常の Lint の対象から外し、この検査からだけ読む（fixture のために本番の Lint を落とさない）。
