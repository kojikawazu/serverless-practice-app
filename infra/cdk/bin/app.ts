import { App } from "aws-cdk-lib";
import { BatchStack } from "../lib/batch-stack";
import { parseStage } from "../lib/stage";

// CDK アプリの入口。ステージは -c stage=local|dev で指定する（docs/09「デプロイ」）
const app = new App();
const stage = parseStage(app.node.tryGetContext("stage"));

// アカウントは CDK CLI が認証情報から設定する。未設定（テストなど）のときは指定しない
const account = process.env.CDK_DEFAULT_ACCOUNT;

new BatchStack(app, `serverless-practice-app-${stage}`, {
  stage,
  env: {
    ...(account === undefined ? {} : { account }),
    region: "ap-northeast-1",
  },
});
