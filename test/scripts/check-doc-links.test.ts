import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/check-doc-links.sh（Markdown の相対リンクの実在を確かめる）を、一時ディレクトリの git リポジトリで動かす（docs/08 #51〜#53）。
// スクリプトは一時ディレクトリに複製し、依存（github-slugger）はリポジトリの node_modules へのシンボリックリンクで解決する。
// 対象を git から引くところまで含めて確かめるため、本体（doc-links.ts）を直接呼ばずに入口のスクリプトから動かす。

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

let workDir: string;

/** スクリプトの実行結果 */
type RunResult = {
  /** 終了コード */
  code: number | null;
  stdout: string;
  stderr: string;
};

/**
 * 一時ディレクトリでコマンドを実行する。失敗したら例外にする（テストの前提づくりの失敗を見逃さない）。
 *
 * @param command - 実行するコマンド
 * @param args - 引数
 */
function sh(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: workDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} が失敗した: ${result.stderr}`,
    );
  }
}

/**
 * 一時ディレクトリにファイルを置く。親ディレクトリも作る。
 *
 * @param file - 一時ディレクトリからの相対パス
 * @param content - 中身
 */
function put(file: string, content: string): void {
  mkdirSync(path.dirname(path.join(workDir, file)), { recursive: true });
  writeFileSync(path.join(workDir, file), content);
}

/**
 * 一時ディレクトリに複製したスクリプトを実行する。
 *
 * @returns 終了コードと出力
 */
function run(): RunResult {
  const result = spawnSync(
    "bash",
    [path.join(workDir, "scripts/check-doc-links.sh")],
    { cwd: workDir, encoding: "utf8", timeout: 60_000 },
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** 見出しの書き方を一通り含むリンク先。どの見出しも、下の正しいリンクから参照する */
const TARGET_DOC = [
  "# 見出しの例",
  "",
  "## 処理時間ごとの実行先",
  "",
  "### データ連携 Lambda（`data-sync`）",
  "",
  "### 状態変化イベント（EventBridge → Slack 通知 Lambda）",
  "",
  "### `dev` での検証結果",
  "",
  "## 概要",
  "",
  "## 概要",
  "",
  "```markdown",
  "## フェンスの中の見出し",
  "```",
  "",
].join("\n");

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "check-doc-links-"));
  mkdirSync(path.join(workDir, "scripts/lib"), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, "scripts/check-doc-links.sh"),
    path.join(workDir, "scripts/check-doc-links.sh"),
  );
  copyFileSync(
    path.join(REPO_ROOT, "scripts/lib/doc-links.ts"),
    path.join(workDir, "scripts/lib/doc-links.ts"),
  );
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(workDir, "node_modules"),
  );
  sh("git", ["init", "-q"]);
  put(".gitignore", "node_modules\n");
  put("docs/target.md", TARGET_DOC);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("check-doc-links.sh", () => {
  describe("正常系", () => {
    it("リンク先のファイル・ディレクトリ・見出しがすべて実在すれば、件数を出して 0 で終わる", () => {
      put(
        "docs/source.md",
        [
          "# 参照する側",
          "",
          "## 自分の見出し",
          "",
          "- [日本語](target.md#処理時間ごとの実行先)",
          "- [全角の括弧とコード](target.md#データ連携-lambdadata-sync)",
          "- [矢印](target.md#状態変化イベントeventbridge--slack-通知-lambda)",
          "- [先頭のコード](./target.md#dev-での検証結果)",
          "- [同名の 1 つ目](target.md#概要)・[同名の 2 つ目](target.md#概要-1)",
          "- [パーセントエンコード](target.md#%E6%A6%82%E8%A6%81)",
          "- [同じファイルの見出し](#自分の見出し)",
          "- [ディレクトリ](../scripts/)・[ファイルだけ](../scripts/check-doc-links.sh)",
          "- [`コード`を含むテキスト](target.md)",
          "- [外部の URL](https://example.com/nope.md#nope)・[メール](mailto:someone@example.com)",
          "",
        ].join("\n"),
      );

      const result = run();

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "Markdown 2 ファイル・相対リンク 11 件を確かめ、切れているもの 0 件",
      );
    });

    it("コードスパン・コードフェンスの中のリンクは確かめない", () => {
      put(
        "docs/source.md",
        [
          "例: `[切れている](nope.md)` は書き方の例",
          "",
          "```markdown",
          "[切れている](nope.md#nope)",
          "```",
          "",
          // ` 1 つで開いたコードスパンは、``` の一部では閉じない。末尾の ` までがコードスパン。
          // ``` の 1 つ目で閉じると、残りの `` に相手が無く、リンクがコードの外に出る
          "`a``` [切れている](nope.md) `",
          "",
        ].join("\n"),
      );

      const result = run();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("相対リンク 0 件");
    });
  });

  describe("準正常系", () => {
    it("リンク先のファイルが無ければ、ファイル・行・リンク先を出して 1 で終わる", () => {
      put("docs/source.md", "# 参照する側\n\n[無いファイル](nope.md)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "docs/source.md:3: リンク先が無い: nope.md",
      );
      expect(result.stdout).toContain("切れているもの 1 件");
    });

    it("見出しが 1 文字違えば、見出しが無いとして 1 で終わる", () => {
      put("docs/source.md", "[1 文字違い](target.md#処理時間ごとの実行)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "docs/source.md:1: 見出しが無い: target.md#処理時間ごとの実行",
      );
    });

    it("同じファイルの中の見出しが無ければ 1 で終わる（MD051 の代わり）", () => {
      put("docs/source.md", "# 見出し\n\n[無い見出し](#nope)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("docs/source.md:3: 見出しが無い: #nope");
    });

    it("コードフェンスの中の # は見出しとして数えない", () => {
      put("docs/source.md", "[フェンスの中](target.md#フェンスの中の見出し)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("見出しが無い");
    });

    it("同名の見出しの 3 つ目（-2）は、2 つしか無ければ無いとして 1 で終わる", () => {
      put("docs/source.md", "[3 つ目](target.md#概要-2)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("見出しが無い: target.md#概要-2");
    });

    it("コミット前の新しいファイルも確かめる（未追跡のファイルを対象に含める）", () => {
      // beforeEach のファイルはどれもコミットしていない。追跡済みだけを見ると、この切れたリンクを見逃す
      put("docs/new-guide.md", "[無いファイル](nope.md)\n");

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("docs/new-guide.md:1: リンク先が無い");
    });

    it(".gitignore で除いたファイルは確かめない", () => {
      put(".gitignore", "node_modules\nignored/\n");
      put("ignored/notes.md", "[無いファイル](nope.md)\n");

      const result = run();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Markdown 1 ファイル");
    });
  });

  describe("異常系", () => {
    it("検査する Markdown が 0 件なら、通さずに 1 で終わる", () => {
      rmSync(path.join(workDir, "docs"), { recursive: true });

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "検査する Markdown のファイルがありません",
      );
    });

    it("git のリポジトリの外では、0 件として通さずに 1 で終わる", () => {
      rmSync(path.join(workDir, ".git"), { recursive: true });

      const result = run();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("git のリポジトリの中で実行してください");
    });

    it("追跡したまま手元で消したファイルは読まずに飛ばす", () => {
      sh("git", ["add", "docs/target.md"]);
      put("docs/source.md", "# 参照する側\n");
      rmSync(path.join(workDir, "docs/target.md"));

      const result = run();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Markdown 1 ファイル");
    });
  });
});
