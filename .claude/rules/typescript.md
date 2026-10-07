---
description: TypeScript コーディング規約 — ツール・type/interface の使い分け・型定義の配置等、TS 固有の指針
globs: "functions/src/**,infra/cdk/**"
---

# TypeScript コーディング規約

共通の `coding-standards.md` に加え、TypeScript 固有の指針を定める。命名規則は Linter 既定に委ね、本書では扱わない。

## ツール

- **コンパイラ**: `tsconfig.json` は **`strict: true`**。加えて `noUncheckedIndexedAccess` / `noImplicitOverride` / `exactOptionalPropertyTypes` の有効化を推奨する。
- **型チェック**: **`tsc --noEmit`** を CI で実行する。バンドラ（Vite / Next.js / esbuild）は型を検査せずビルドを通すため、**ビルドが通ることは型が正しいことを意味しない**。
- **Linter**: **スタックの公式の既定に合わせる。** 既定から外れると、雛形の設定・スクリプトを置き換えて保守し続けることになる。FE と BE で Linter が分かれてよい（設定はワークスペースごとに持つ）。

  | 構成 | Linter | 設定ファイル |
  |---|---|---|
  | FE（Next.js / Nuxt.js / React / Vue.js）・Hono（雛形に Linter を含まないため ESLint に揃える） | ESLint（flat config）+ `typescript-eslint` | `eslint.config.*` |
  | NestJS | oxlint（`--type-aware`。`oxlint-tsgolint` を併用） | `.oxlintrc.json` |

- **型情報を使うルール**（`no-floating-promises` / `no-misused-promises` / `await-thenable`）を、どちらの Linter でも `error` にする — **await 漏れは型だけでは検出できない**ため実害が大きい。oxlint では `typescript/` 接頭辞で指定し、**`--type-aware` を付けて実行する。付けないと、これらのルールを `error` にしていても警告もエラーも出ずに終了コード 0 で通る**（検査が黙って抜ける）。Lint のスクリプト（`package.json` の `lint`）に付けておき、CI もそれを呼ぶ。
- **Formatter**: **Prettier**（デフォルト設定に従う）。ESLint の構成では **`eslint-config-prettier` を必ず適用**し、ESLint 側の見た目ルールを無効化して競合を防ぐ。oxlint の構成では、見た目のルール（`style` カテゴリ）を有効にしない。
- **JSDoc の強制**: ESLint の構成は `eslint-plugin-jsdoc`、oxlint の構成は `jsPlugins` で `eslint-plugin-jsdoc` の `require-jsdoc` を読み込む（詳細は `jsdoc.md`）。
- 運用（CI 必須・警告ゼロ・抑制コメントの扱い）は `static-analysis.md` に従う。

## type vs interface

**原則 `type` を使う。** 以下の 2 条件のいずれかに当たる場合のみ `interface` を使う。

- **条件 1: class 契約** — その型を **class が `implements` / `extends` する**
  - サービス契約・リポジトリポート・DI 抽象など
  - → NestJS のような**クラス中心の層**で主に該当
- **条件 2: 宣言マージが必要** — 型を**後から拡張する**必要がある
  - ライブラリ型の拡張（`declare module 'express' { interface Request { user?: AuthUser } }`）
  - グローバル型の拡張（`declare global { interface Window { ... } }`）
  - 公開ライブラリとして**利用者に拡張させる**型
  - → `type` は宣言マージできないため、ここは `interface` でしか実現できない
- **`type` を使う**（上記以外すべて）
  - class が絡まないオブジェクト形状（props・DTO・レスポンス型）
  - union / 交差 / tuple / 関数型 / mapped・conditional 型などの型演算
  - → React / Vue / Hono のような**関数・データ中心の層**

宣言マージは「意図せず型が拡張され得る」副作用でもある。**アプリ内部の型に `interface` を選ぶ理由にはしない**（条件 1 か、外部から拡張される前提の型に限る）。

```ts
// 条件 1: class 契約 → interface（NestJS 等）
interface TaskRepository {
  findById(id: string): Promise<Task | null>;
}

@Injectable()
class PrismaTaskRepository implements TaskRepository {
  /* ... */
}

// 条件 2: 宣言マージ → interface
declare module 'hono' {
  interface ContextVariableMap {
    currentUser: AuthUser;
  }
}

// それ以外 → type（FE データ・union・関数型）
type TaskStatus = 'todo' | 'doing' | 'done';
type TaskProps = { id: string; title: string; status: TaskStatus };
type OnSelect = (id: string) => void;
```

**補足**: NestJS の DTO は `createZodDto()` の戻り値を継承するため **class** になる（type/interface ではない）。本節は「型定義」に対する指針であり、DTO クラスは対象外。

## スキーマバリデーションは Zod に統一する

**TypeScript のスキーマバリデーションは Zod を使う。** フロントエンド・BFF・バックエンドで**同じ 1 つのライブラリに揃える**（`class-validator` / `yup` / `joi` / 自前の検証関数を混在させない）。

- **理由**: スタックごとに検証ライブラリが変わると、同じ入力ルールを別の書き方で二重に定義することになる。Zod なら**スキーマそのものを共有でき**、片方から他方を導出できる。
- **型はスキーマから導出する**。`z.infer<typeof schema>` を使い、**同じ形を手書きで二重定義しない**（`duplication.md`）。**スキーマが単一の真実**であり、型はその影である。
- 外部入力（API レスポンス・`JSON.parse`・フォーム入力・環境変数）は `unknown` で受け、**Zod で `parse` してからドメインに入れる**。
- モノレポでフロントとバックエンドを持つ場合、**共有パッケージにスキーマを置いて双方から参照する**ことを検討する（信頼境界が違うため検証自体は両方で必要だが、定義は 1 つでよい）。
- 用途別のアダプタを使う（`@hono/zod-validator` / `nestjs-zod` / `react-hook-form` の `zodResolver` / VeeValidate の `toTypedSchema`）。**アダプタは変わってもスキーマは変わらない**。

### スキーマの配置（`schemas/` 集約）

- スキーマは**ソースルート直下の `schemas/` ディレクトリ**に集約する（`src/` 構成なら `src/schemas/`）。**Zod を使わない構成でのみ `validation/`** という名前を用いる。
- **`lib/validation.ts` のような単一ファイルにまとめない。** ディレクトリを切り、ドメイン単位でファイルを分ける（`schemas/task.ts` / `schemas/user.ts`）。`lib/` `utils/` の下に置かない（「関数の置き場」と分離する）。
- **スキーマから導出した型は `types/` に再定義しない。** `z.infer<typeof taskSchema>` を `schemas/task.ts` から `export` し、それを参照する（手書きの二重定義は `duplication.md` 違反）。
- **検証を伴わない純粋な型は `schemas/` に置かない**（`types/` へ）。`schemas/` に置くのは「実行時に `parse` するもの」だけ。
- barrel（`schemas/index.ts`）は作らない（理由は型・定数と同じ）。

## 型定義の配置（コロケーション / `types/` 集約）

型を各ファイルに散在させず、**参照範囲**で置き場所を決める。判断軸は「**その型を参照するファイルが 1 つに閉じるか**」。

| 参照範囲 | 置き場所 |
|---|---|
| **1 ファイルに閉じる** | その定義ファイル内にコロケーション（`export` しない） |
| **2 ファイル以上** / レイヤ・機能をまたぐ | `types/` に集約して `export` |

### 置き場所（ディレクトリを切る）

- 集約先は**ソースルート直下の `types/` ディレクトリ**とする。`src/` を採用する構成（Next.js・Vite・NestJS 等）では **`src/types/`**、Nuxt は srcDir 直下（Nuxt 4 の新構成なら **`app/types/`**、`app/` を持たない構成なら **`types/`**）。
- **単一ファイルにまとめない。** `lib/type.ts` / `src/type.ts` のように 1 ファイルへ全型を詰め込む形は禁止。必ず**ディレクトリを切り、ドメイン単位でファイルを分ける**。
- **`lib/` `utils/` の下に型ファイルを置かない。** `lib/` は「関数の置き場」、`types/` は「型の置き場」で分離する（定数も同様。「定数の配置」参照）。
- 命名は**ディレクトリが複数形の `types`、ファイルはドメイン名の単数形**（`types/task.ts` / `types/user.ts`）。`type.ts` / `Types.ts` のような単数形・PascalCase のディレクトリ名は使わない。

```text
src/
├── repositories/   # API アクセス（通信はここだけ）
├── schemas/        # Zod スキーマ
├── lib/            # 純粋ユーティリティ（通信しない）
├── constants/      # 値
└── types/          # 型
    ├── task.ts
    └── user.ts
```

❌ `src/lib/type.ts` に全型を詰め込む / ✅ `src/types/task.ts` にドメイン単位で分ける

### 運用ルール

- **最初から `types/` に置かない。** まず定義ファイル内に書き、**2 箇所目の参照が発生した時点で `types/` へ昇格**させる。先回りの集約は、使われない共通型と不要な依存を増やす。
- **昇格時は元ファイルに型を残さない**（re-export も含む）。定義は常に 1 箇所。
- `types/` はドメイン単位でファイルを分ける（`types/task.ts` / `types/user.ts`）。1 ファイルに全ドメインを詰めない。
- **barrel（`types/index.ts` からの一括 re-export）は作らない。** 循環参照・バンドル肥大・tree-shaking 阻害の原因になる。`import type { Task } from '@/types/task'` と**実ファイルを直接 import** する。

### 分類の目安

- **`types/` に置く**: API レスポンス/リクエスト型、ドメインエンティティ、複数画面で共有する union リテラル、共通のユーティリティ型
- **コロケーションのまま**: コンポーネントの props 型（コンポーネントと 1:1 で、UI の変更と同時に変わる）、そのファイル内でしか使わない内部型・引数オブジェクト型

```ts
// コンポーネント固有 → コロケーション（export しない）
type TaskCardProps = { task: Task; onSelect: (id: string) => void };
export function TaskCard({ task, onSelect }: TaskCardProps) { /* ... */ }

// 複数箇所から参照 → types/task.ts に集約
// types/task.ts
export type TaskStatus = 'todo' | 'doing' | 'done';
export type Task = { id: string; title: string; status: TaskStatus };
```

### 型へのコメント

`type` / `interface` は**型本体・各メンバーともにコメント必須**。詳細は `jsdoc.md`（必須対象・記述ルール）に従う。

## 定数の配置（`constants/` 集約）

**マジックナンバー・マジック文字列を直接書かない。** 分岐条件・API パス・ストレージキー・上限値・リトライ回数などのリテラルは名前付き定数にする。名前が付いていない値は、検索もできず変更漏れも検出できない。

置き場所は型と**同じ「参照範囲」の軸**で決める。

| 参照範囲 | 置き場所 |
|---|---|
| **1 ファイルに閉じる** | その定義ファイルの先頭で `const` 宣言（`export` しない） |
| **2 ファイル以上** / レイヤ・機能をまたぐ | `constants/` に集約して `export` |

### 置き場所（ディレクトリを切る）

型と同じ方針で置き場所を決める（詳細は「型定義の配置」の同名節）。

- 集約先は**ソースルート直下の `constants/` ディレクトリ**。`src/` 構成なら **`src/constants/`**、Nuxt は srcDir 直下（**`app/constants/`** または **`constants/`**）。
- **単一ファイルにまとめない。** `lib/constants.ts` / `src/constants.ts` のように 1 ファイルへ全定数を詰め込む形は禁止。**ディレクトリを切り、ドメイン単位でファイルを分ける**。
- 命名は**ディレクトリが複数形の `constants`**（`constant.ts` のような単数形の単一ファイルにしない）。

❌ `src/lib/constants.ts` に全定数を詰め込む / ✅ `src/constants/task.ts` にドメイン単位で分ける

### 運用ルール

- **`lib/` や `utils/` に定数を混ぜない。** 「関数の置き場」と「値の置き場」を分けると、変更時に探す範囲が狭まる。
- 昇格の運用は型と同じ: まず使う場所に書き、**2 箇所目の参照が発生した時点で `constants/` へ移す**。移動時は元ファイルに残さない（re-export も含む）。
- `constants/` はドメイン単位でファイルを分ける（`constants/task.ts` / `constants/api.ts`）。**barrel（`constants/index.ts`）は作らない**（理由は型と同じ）。
- **`as const` を付ける。** 付けないとリテラル型が `string` / `number` に広がり、union の導出や補完が効かなくなる。
- 命名は `UPPER_SNAKE_CASE`。オブジェクト定数のキーも同様に揃える。

### 型の元になる定数は「型と同じファイル」に置く

union リテラルの元になる配列・オブジェクトは、**導出される型とセットで `types/` 側に置く**。`constants/` と `types/` に分けると、値と型が常に往復参照になり、片方だけ更新される事故が起きる。

```ts
// types/task.ts — 値と型はペアで同居させる
/** タスクの進行状態。表示順もこの配列の順序に従う。 */
export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
/** タスクの進行状態。遷移は配列順の一方向のみ */
export type TaskStatus = (typeof TASK_STATUSES)[number];

// constants/task.ts — 型を導出しない純粋な値はこちら
/** 一覧の 1 ページあたり件数。API 側の上限（100）を超えない */
export const TASK_PAGE_SIZE = 20;
```

### 環境変数は定数ではない

環境ごとに値が変わるもの（API のベース URL、キー、フィーチャーフラグ）を `constants/` に置かない。ビルド時に特定環境の値が埋め込まれ、環境差異の事故につながる。**設定は env スキーマ経由で読み込む層**（`config/` 等）に分離する。`constants/` に置くのは**全環境で不変な値**だけ。

### 定数へのコメント

`export` された定数は**コメント必須**（`jsdoc.md`）。特に**単位**（`TIMEOUT_MS` がミリ秒であること）と**その値である根拠**（「API 側の上限が 100 のため」）を書く。根拠のない数値は、後から誰も変更してよいか判断できない。

## any 禁止・unknown 優先

- **暗黙・明示を問わず `any` を禁止**する（`noImplicitAny` 前提）。
- 外部入力（API レスポンス・`JSON.parse`・ユーザー入力）は **`unknown` で受け**、型ガード・スキーマ検証（zod 等）で**ナローイング**してから使う。
- どうしても `any` が必要な箇所は根拠コメントを残す（「as/! 抑制」節参照）。

## enum 回避・union リテラル + as const

- `enum` より **union リテラル型**＋必要なら **`as const`** を優先する。
- 理由: `enum` はランタイムにオブジェクトを生成しバンドルに残る／tree-shaking されにくい／`const enum` は分離コンパイルで問題が出る。union リテラルは型のみで**ランタイムコストゼロ**。

```ts
// 非推奨
enum Status { Todo, Doing, Done }
// 推奨
const STATUSES = ['todo', 'doing', 'done'] as const;
type Status = (typeof STATUSES)[number];
```

## import type 強制

- 型だけを import する場合は **`import type`** を使う（値と型を混ぜない）。
- 理由: バンドラ／トランスパイラが型を確実に消せる、副作用のない循環参照を避けられる。`verbatimModuleSyntax` 有効化を推奨。

```ts
import type { User } from './user';
import { createUser } from './user';
```

## as / ! 抑制

- 型アサーション `as` と non-null assertion `!` を**最小化**する。まず型ガード・早期 return・オプショナルチェーンで解決する。
- 使う場合は**根拠コメント必須**（なぜ安全か／なぜ必要か）。`as unknown as` / `as any` / `@ts-ignore` / `@ts-expect-error` の根拠記述は `jsdoc.md`（混乱テスト）と接続する。
- `as const`（リテラル固定）はここでの「アサーション」に含まない（推奨用途）。
