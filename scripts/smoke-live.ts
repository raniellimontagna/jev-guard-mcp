import { PlaywrightBrowserDriver } from "../src/browser/playwright-driver.js";
import { createTypeSafeTransport, TypeSafeJevClient } from "../src/decision/typesafe-client.js";
import { GuardService } from "../src/guard/guard-service.js";

const execute = process.argv.includes("--execute");
const positional = process.argv.slice(2).filter((value) => value !== "--execute");
const url = positional[0] ?? "https://en.wikipedia.org/wiki/Headless_browser";
const goal = positional[1] ?? "Open the Wikipedia article about web browsers";
const apiKey = process.env.TYPESAFE_API_KEY?.trim();

if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for the live smoke test");

const guard = new GuardService(
  new PlaywrightBrowserDriver(),
  new TypeSafeJevClient(createTypeSafeTransport(apiKey)),
);

try {
  const preview = await guard.preview({ url, goal });
  if (preview.status !== "ready") {
    console.log(JSON.stringify({ phase: "preview", result: preview }, null, 2));
  } else {
    const { token, ...safePreview } = preview;
    console.log(JSON.stringify({ phase: "preview", result: safePreview }, null, 2));
    if (execute) {
      console.log(JSON.stringify({ phase: "execute", result: await guard.execute(token) }, null, 2));
    } else {
      await guard.cancel(token);
      console.log(JSON.stringify({ phase: "cancel", result: { status: "cancelled" } }, null, 2));
    }
  }
} finally {
  await guard.close();
}
