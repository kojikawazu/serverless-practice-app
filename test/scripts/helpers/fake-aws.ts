// scripts/budget-alert.sh のテストで、PATH の先頭に置く偽の AWS CLI（test/scripts/budget-alert.test.ts）。
// LocalStack は Budgets に対応していないため、外部 I/O（AWS CLI）だけをこれに差し替える（.claude/rules/testing.md）。
// Node の型除去（--experimental-strip-types）でそのまま動かすため、型の注釈以外の TypeScript 固有の構文を使わない。
//
// 環境変数:
//   FAKE_AWS_STATE   予算の状態を持つ JSON ファイル。呼び出しのたびに読み書きする
//   FAKE_AWS_LOG     呼び出しを 1 行 1 JSON で追記するファイル
//
// 引数・状態の JSON は `JSON.parse(...) as 型` で読み、検証しない。書くのはスクリプト（あるべき設定）とテスト（初期状態）だけで、
// 形が違えばテストが落ちて分かるため。テスト用の偽物に Zod の検証を足すと、偽物の誤りを探す場所が増えるだけになる。
//
// 返す値の形は実 AWS に寄せる: 額は "3.0" のように小数で、通知には NotificationState が付き、
// 予算には AWS が補う項目（CostTypes・TimePeriod・CalculatedSpend）が付く。スクリプトがこれらでずれと誤判定しないことを確かめるため。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** 予算の通知（スクリプトが決める 4 項目） */
type Notification = {
  NotificationType: string;
  ComparisonOperator: string;
  Threshold: number;
  ThresholdType: string;
};

/** 通知先 */
type Subscriber = { SubscriptionType: string; Address: string };

/** 偽の AWS が持つ状態。テストが初期状態を書き、呼び出しの後に読んで確かめる */
export type FakeAwsState = {
  accountId: string;
  /** 予算。`null` は「無い」 */
  budget: {
    BudgetName: string;
    BudgetType: string;
    TimeUnit: string;
    BudgetLimit: { Amount: string; Unit: string };
  } | null;
  notifications: { notification: Notification; subscribers: Subscriber[] }[];
  /** 操作名（`describe-budget` など）ごとに、返すエラーコード。権限不足などを再現する */
  failOn?: Record<string, string>;
  /** 成功を返すが状態を変えない操作名。「API は成功したのに反映されていない」を再現する */
  ignore?: string[];
};

const statePath = process.env["FAKE_AWS_STATE"];
const logPath = process.env["FAKE_AWS_LOG"];
if (statePath === undefined || logPath === undefined) {
  process.stderr.write("fake-aws: FAKE_AWS_STATE と FAKE_AWS_LOG が要ります\n");
  process.exit(255);
}

const args = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(args)}\n`);

// --name value の組と、それ以外（サービス名・操作名）に分ける
const options: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? "";
  if (arg.startsWith("--")) {
    options[arg.slice(2)] = args[i + 1] ?? "";
    i += 1;
  } else {
    positional.push(arg);
  }
}
const [service, operation] = positional;
const state = JSON.parse(readFileSync(statePath, "utf8")) as FakeAwsState;

/**
 * AWS CLI と同じ形のエラーを出して終える。スクリプトはエラーコード（括弧の中）で判定する。
 *
 * @param code - エラーコード
 * @param message - メッセージ
 */
function fail(code: string, message: string): never {
  process.stderr.write(
    `\nAn error occurred (${code}) when calling the ${operation ?? ""} operation: ${message}\n`,
  );
  process.exit(254);
}

/**
 * 応答を出し、状態を保存して終える。
 *
 * @param body - 標準出力に出す JSON
 */
function reply(body: unknown): never {
  writeFileSync(statePath ?? "", JSON.stringify(state));
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(0);
}

/**
 * 通知をスクリプトが決める 4 項目で比べるための文字列にする。
 *
 * @param n - 通知
 * @returns 比較用の文字列
 */
function notificationKey(n: Notification): string {
  return JSON.stringify([
    n.NotificationType,
    n.ComparisonOperator,
    Number(n.Threshold),
    n.ThresholdType,
  ]);
}

/**
 * 引数の通知に一致する、状態の中の通知を探す。無ければ NotFoundException で終える。
 *
 * @returns 一致した通知と通知先
 */
function findNotification(): FakeAwsState["notifications"][number] {
  const wanted = JSON.parse(options["notification"] ?? "{}") as Notification;
  const found = state.notifications.find(
    (e) => notificationKey(e.notification) === notificationKey(wanted),
  );
  return found ?? fail("NotFoundException", "notification not found");
}

/**
 * 予算があることを確かめる。無ければ NotFoundException で終える。
 */
function requireBudget(): void {
  if (
    state.budget === null ||
    state.budget.BudgetName !== options["budget-name"]
  ) {
    fail("NotFoundException", "budget not found");
  }
}

if (operation !== undefined && state.failOn?.[operation] !== undefined) {
  fail(state.failOn[operation], "injected by the test");
}

if (operation !== undefined && state.ignore?.includes(operation) === true) {
  process.stdout.write("{}\n");
  process.exit(0);
}

switch (`${service ?? ""} ${operation ?? ""}`) {
  case "sts get-caller-identity":
    reply({ Account: state.accountId, Arn: "arn:aws:iam::fake:user/test" });
    break;
  case "budgets describe-budget":
    requireBudget();
    reply({
      Budget: {
        ...state.budget,
        BudgetLimit: {
          ...state.budget?.BudgetLimit,
          Amount: Number(state.budget?.BudgetLimit.Amount).toFixed(1),
        },
        CostTypes: { IncludeTax: true, IncludeSupport: true },
        TimePeriod: { Start: "2026-10-14T00:00:00+00:00" },
        CalculatedSpend: { ActualSpend: { Amount: "0.12", Unit: "USD" } },
      },
    });
    break;
  case "budgets create-budget": {
    if (state.budget !== null) {
      fail("DuplicateRecordException", "budget already exists");
    }
    state.budget = JSON.parse(
      options["budget"] ?? "{}",
    ) as FakeAwsState["budget"];
    const entries = JSON.parse(
      options["notifications-with-subscribers"] ?? "[]",
    ) as { Notification: Notification; Subscribers: Subscriber[] }[];
    state.notifications = entries.map((e) => ({
      notification: e.Notification,
      subscribers: e.Subscribers,
    }));
    reply({});
    break;
  }
  case "budgets update-budget":
    state.budget = JSON.parse(
      options["new-budget"] ?? "{}",
    ) as FakeAwsState["budget"];
    reply({});
    break;
  case "budgets describe-notifications-for-budget":
    requireBudget();
    reply({
      Notifications: state.notifications.map((e) => ({
        ...e.notification,
        Threshold: Number(e.notification.Threshold),
        NotificationState: "OK",
      })),
    });
    break;
  case "budgets describe-subscribers-for-notification":
    requireBudget();
    reply({ Subscribers: findNotification().subscribers });
    break;
  case "budgets create-notification": {
    requireBudget();
    const notification = JSON.parse(
      options["notification"] ?? "{}",
    ) as Notification;
    state.notifications.push({
      notification,
      subscribers: JSON.parse(options["subscribers"] ?? "[]") as Subscriber[],
    });
    reply({});
    break;
  }
  case "budgets delete-notification": {
    requireBudget();
    const target = findNotification();
    state.notifications = state.notifications.filter((e) => e !== target);
    reply({});
    break;
  }
  case "budgets create-subscriber":
    requireBudget();
    findNotification().subscribers.push(
      JSON.parse(options["subscriber"] ?? "{}") as Subscriber,
    );
    reply({});
    break;
  case "budgets delete-subscriber": {
    requireBudget();
    const entry = findNotification();
    const target = JSON.parse(options["subscriber"] ?? "{}") as Subscriber;
    entry.subscribers = entry.subscribers.filter(
      (s) =>
        s.SubscriptionType !== target.SubscriptionType ||
        s.Address !== target.Address,
    );
    reply({});
    break;
  }
  default:
    fail(
      "FakeAwsUnsupported",
      `fake-aws は ${args.join(" ")} に対応していません`,
    );
}
