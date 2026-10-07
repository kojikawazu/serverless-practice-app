// @ts-check
// ESLint の設定。運用方針（CI 必須・警告ゼロ・抑制の作法）の正本は .claude/rules/static-analysis.md、
// TypeScript 固有の方針は typescript.md、JSDoc の方針は jsdoc.md。
// ルールは error か off のどちらかにする（warn は放置されて検出装置として働かなくなる）。
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

// JSDoc 検出の回帰テスト（test/lint/jsdoc.test.ts）が読む fixture。
// 意図的に JSDoc を欠いたコードを含むため、通常の Lint からは外し、JSDoc ルールの対象にだけ入れる。
const JSDOC_FIXTURES = "test/lint/fixtures/**/*.ts";

export default defineConfig(
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "cdk.out/",
      "dist/",
      JSDOC_FIXTURES,
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // await 漏れは型だけでは検出できないため、型情報ルールを明示して error に固定する
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // 型だけの import は import type に分ける（verbatimModuleSyntax と揃える）
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // 設定ファイル（JS）は tsconfig の対象外のため、型情報ルールを外す
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // 公開シンボルへの JSDoc 必須。対象は jsdoc.md のスコープ（functions/src・infra/cdk）。
    files: ["functions/src/**/*.ts", "infra/cdk/**/*.ts", JSDOC_FIXTURES],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          // 既定の自動修正は空の /** */ を挿入して欠落の検出を黙らせるため無効にする
          enableFixer: false,
          // publicOnly は使わず、export の有無を AST セレクタで明示する（jsdoc.md）
          require: { FunctionDeclaration: false },
          contexts: [
            "ExportNamedDeclaration > FunctionDeclaration",
            "ExportDefaultDeclaration > FunctionDeclaration",
            "ExportNamedDeclaration > ClassDeclaration",
            "ExportDefaultDeclaration > ClassDeclaration",
            "ExportNamedDeclaration > ClassDeclaration > ClassBody > MethodDefinition[accessibility!='private'][kind!='constructor']",
            "ExportNamedDeclaration > TSTypeAliasDeclaration",
            "ExportNamedDeclaration > TSInterfaceDeclaration",
            "ExportNamedDeclaration > VariableDeclaration",
          ],
        },
      ],
      "jsdoc/no-blank-blocks": "error",
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/check-param-names": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/check-tag-names": "error",
      // 型は TypeScript のシグネチャが正本。JSDoc に {string} 等を書かせない
      "jsdoc/no-types": "error",
    },
  },
  // 見た目のルールを無効化して Prettier と競合させない（最後に置く）
  prettier,
);
