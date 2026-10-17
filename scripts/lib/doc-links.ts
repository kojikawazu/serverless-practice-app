// Markdown の相対リンクの、リンク先（ファイル・ディレクトリ）と見出しの実在を確かめる（scripts/check-doc-links.sh から呼ぶ）。
// 同じファイルの中の `#見出し` もここで確かめ、markdownlint の MD051 は無効にしている（.markdownlint-cli2.jsonc）。
// Node の型除去（--experimental-strip-types）でそのまま動かすため、型の注釈以外の TypeScript 固有の構文を使わない。
//
// 使い方: node --experimental-strip-types scripts/lib/doc-links.ts <Markdown のファイル>...
// 終了コード: 0 = すべて実在する、1 = 切れたリンクがある・対象のファイルが無い
//
// 解析は、このリポジトリの書き方（インラインのリンクだけ。参照形式のリンク・HTML のアンカーは使っていない）に絞った
// 最小限のもの。コードフェンスの中とコードスパンの中のリンク・見出しは数えない。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";

/** 切れたリンク 1 件 */
type BrokenLink = {
  /** リンクを書いたファイル（引数で渡されたままのパス） */
  file: string;
  /** リンクを書いた行（1 始まり） */
  line: number;
  /** リンク先（書かれたまま） */
  target: string;
  /** 切れている理由 */
  reason: string;
};

/** フェンスの開き（3 文字以上の ` か ~。前に空白 3 つまで） */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** インラインのリンク・画像。リンク先の後ろの "タイトル" は読み捨てる */
const INLINE_LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** ATX の見出し。閉じの # は除く */
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** スキーム付きの URL（http: / https: / mailto: など）。このスクリプトの対象外 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * コードフェンスの外にある行を、行番号付きで返す。
 *
 * @param text - Markdown の本文
 * @returns フェンスの外の行と、その行番号（1 始まり）
 */
function linesOutsideFences(text: string): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  let fence: string | null = null;
  text.split("\n").forEach((raw, i) => {
    const match = FENCE_OPEN.exec(raw);
    if (fence === null) {
      if (match?.[1] !== undefined) {
        fence = match[1];
        return;
      }
      result.push({ line: i + 1, text: raw });
      return;
    }
    // 閉じは、開きと同じ文字で、開き以上の長さの並びだけの行
    const marker: string = fence;
    const trimmed = raw.trim();
    if (
      trimmed.length >= marker.length &&
      trimmed === (marker[0] ?? "").repeat(trimmed.length)
    ) {
      fence = null;
    }
  });
  return result;
}

/**
 * 行の中のコードスパンを、同じ長さの空白に置き換える。開きと同じ数の ` で閉じたものだけをコードスパンとみなす。
 *
 * @param line - 1 行の本文
 * @returns コードスパンの中を空白にした行
 */
function blankCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") {
      run += 1;
    }
    const ticks = "`".repeat(run);
    let close = line.indexOf(ticks, i + run);
    // 長い並びの一部に一致したものは閉じではない（`` の中の ` など）
    while (
      close !== -1 &&
      (line[close - 1] === "`" || line[close + run] === "`")
    ) {
      close = line.indexOf(ticks, close + 1);
    }
    if (close === -1) {
      out += ticks;
      i += run;
      continue;
    }
    out += " ".repeat(close + run - i);
    i = close + run;
  }
  return out;
}

/** 見出しの ID の集合（ファイルごとに 1 回だけ作る） */
const anchorCache = new Map<string, Set<string>>();

/**
 * Markdown のファイルの見出しから、GitHub と同じ規則で ID の集合を作る。
 *
 * @param file - Markdown のファイルの絶対パス
 * @returns 見出しの ID の集合。同名の見出しは `-1`・`-2` を付けた ID になる
 */
function anchorsOf(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  for (const { text } of linesOutsideFences(readFileSync(file, "utf8"))) {
    const heading = ATX_HEADING.exec(text)?.[1];
    if (heading === undefined) {
      continue;
    }
    // GitHub は描画後の文字から ID を作る。リンクはテキストだけ、コードスパンは中身だけが残る
    const rendered = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+/g, "");
    anchors.add(slugger.slug(rendered));
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/**
 * パーセントエンコードを戻す。壊れたエンコードはそのまま返し、実在しないリンクとして報告させる。
 *
 * @param value - リンク先のパスかフラグメント
 * @returns 戻した文字列
 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 1 つの Markdown のファイルの相対リンクを確かめる。
 *
 * @param file - 確かめるファイル（引数で渡されたままのパス）
 * @returns 確かめたリンクの数と、切れたリンク
 */
function checkFile(file: string): { checked: number; broken: BrokenLink[] } {
  const broken: BrokenLink[] = [];
  let checked = 0;
  const source = path.resolve(file);
  for (const { line, text } of linesOutsideFences(
    readFileSync(source, "utf8"),
  )) {
    for (const match of blankCodeSpans(text).matchAll(INLINE_LINK)) {
      const target = match[1] ?? "";
      if (HAS_SCHEME.test(target)) {
        continue;
      }
      checked += 1;
      const hash = target.indexOf("#");
      const pathPart = decode(hash === -1 ? target : target.slice(0, hash));
      const fragment = hash === -1 ? null : decode(target.slice(hash + 1));
      const dest =
        pathPart === "" ? source : path.resolve(path.dirname(source), pathPart);
      if (!existsSync(dest)) {
        broken.push({ file, line, target, reason: "リンク先が無い" });
        continue;
      }
      // 見出しを確かめられるのは Markdown のファイルだけ（ソースコードの #L10 などは確かめない）
      if (
        fragment === null ||
        !statSync(dest).isFile() ||
        path.extname(dest) !== ".md"
      ) {
        continue;
      }
      if (!anchorsOf(dest).has(fragment)) {
        broken.push({ file, line, target, reason: "見出しが無い" });
      }
    }
  }
  return { checked, broken };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  // 対象の列挙の失敗を「切れたリンク 0 件」として通さない
  console.error("エラー: 検査する Markdown のファイルがありません");
  process.exit(1);
}

let checked = 0;
const broken: BrokenLink[] = [];
for (const file of files) {
  const result = checkFile(file);
  checked += result.checked;
  broken.push(...result.broken);
}
for (const b of broken) {
  console.error(`${b.file}:${b.line}: ${b.reason}: ${b.target}`);
}
console.log(
  `Markdown ${files.length} ファイル・相対リンク ${checked} 件を確かめ、切れているもの ${broken.length} 件`,
);
process.exit(broken.length === 0 ? 0 : 1);
