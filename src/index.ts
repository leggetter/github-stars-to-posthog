import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN as string;
const HOOKDECK_API_KEY = process.env.HOOKDECK_API_KEY as string;
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY as string;
const POSTHOG_HOST = process.env.POSTHOG_HOST as string;
const REPO_OWNER = process.env.REPO_OWNER as string;
const REPO_NAME = process.env.REPO_NAME as string;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET as string;
const GITHUB_REPO = `${REPO_OWNER}/${REPO_NAME}`;

if (
  !GITHUB_TOKEN ||
  !HOOKDECK_API_KEY ||
  !POSTHOG_HOST ||
  !POSTHOG_API_KEY ||
  !REPO_OWNER ||
  !REPO_NAME ||
  !GITHUB_WEBHOOK_SECRET
) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const safeGitHubRepoName = GITHUB_REPO.replace("/", "-");

const hookdeckHeaders = {
  Authorization: `Bearer ${HOOKDECK_API_KEY}`,
  "Content-Type": "application/json",
};

// Get the equivalent of __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define an interface for the Source object
interface HookdeckSource {
  id: string;
  name: string;
  url: string; // Changed from 'endpoint' to 'url'
  created_at: string;
  updated_at: string;
}

async function createSource(): Promise<HookdeckSource> {
  try {
    const response = await fetch(
      "https://api.hookdeck.com/2025-01-01/sources",
      {
        method: "PUT",
        headers: hookdeckHeaders,
        body: JSON.stringify({
          name: `gh-stars-src-${safeGitHubRepoName}`,
          type: "GITHUB",
          config: {
            auth: {
              webhook_secret_key: GITHUB_WEBHOOK_SECRET,
            },
          },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = (await response.json()) as HookdeckSource;
    console.log(`✅ Hookdeck Source created: ${data.id}`);
    console.log(`📌 Source URL: ${data.url}`); // Changed from 'endpoint' to 'url'
    return data;
  } catch (error: any) {
    console.error("❌ Failed to create Hookdeck Source:", error.message);
    process.exit(1);
  }
}

async function createDestination(): Promise<string> {
  try {
    const posthogUrl = `${POSTHOG_HOST}/i/v0/e/`; // Include API key in URL

    // Could reuse the destinations
    const response = await fetch(
      "https://api.hookdeck.com/2025-01-01/destinations",
      {
        method: "PUT",
        headers: hookdeckHeaders,
        body: JSON.stringify({
          name: `posthog-${safeGitHubRepoName}`,
          config: {
            url: posthogUrl,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    const destinationId = data.id;
    console.log(`✅ Hookdeck Destination created: ${destinationId}`);
    return destinationId;
  } catch (error: any) {
    console.error("❌ Failed to create Hookdeck Destination:", error.message);
    process.exit(1);
  }
}

async function createConnection(
  sourceId: string,
  destinationId: string
): Promise<string> {
  try {
    const transformScriptPath = path.resolve(__dirname, "../dist/transform.js");
    let transformScript = fs.readFileSync(transformScriptPath, "utf8");
    transformScript = transformScript.replace(
      /"use strict";/,
      '"use strict";\nconst exports={};\n'
    );

    const response = await fetch(
      "https://api.hookdeck.com/2025-01-01/connections",
      {
        method: "PUT",
        headers: hookdeckHeaders,
        body: JSON.stringify({
          name: `gh-stars-conn-${safeGitHubRepoName}`,
          source_id: sourceId,
          destination_id: destinationId,
          rules: [
            {
              type: "transform",
              transformation: {
                name: "github-star-to-posthog-capture",
                code: transformScript,
                env: {
                  POSTHOG_API_KEY,
                },
              },
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    const connectionId = data.id;
    console.log(`✅ Hookdeck Connection created: ${connectionId}`);
    return connectionId;
  } catch (error: any) {
    console.error("❌ Failed to create Hookdeck Connection:", error.message);
    process.exit(1);
  }
}

// Interface for GitHub webhook response
interface GitHubWebhook {
  id: number;
  type: string;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url: string;
    content_type: string;
    secret?: string;
    insecure_ssl?: string;
  };
}

async function getExistingWebhook(): Promise<GitHubWebhook | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/hooks`,
      {
        method: "GET",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch webhooks: ${response.status}`);
    }

    const webhooks = (await response.json()) as GitHubWebhook[];

    // Find the first webhook for the 'star' event
    // Note that this just checks for any webhook registered for the 'star' event
    return (
      webhooks.find(
        (webhook) => webhook.events.includes("star") && webhook.name === "web"
      ) || null
    );
  } catch (error) {
    console.error("Failed to check for existing webhooks:", error);
    return null;
  }
}

async function createGitHubWebhook(sourceUrl: string) {
  try {
    const existingWebhook = await getExistingWebhook();

    const webhookPayload = {
      name: "web",
      active: true,
      events: ["star"],
      config: {
        url: sourceUrl,
        content_type: "json",
        secret: GITHUB_WEBHOOK_SECRET,
      },
    };

    let response;

    if (existingWebhook) {
      console.log(
        `📝 Updating existing GitHub webhook (ID: ${existingWebhook.id})...`
      );
      response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/hooks/${existingWebhook.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(webhookPayload),
        }
      );
    } else {
      console.log(`➕ Creating new GitHub webhook...`);
      response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/hooks`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(webhookPayload),
        }
      );
    }

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `API error: ${response.status} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    console.log(
      `✅ GitHub Webhook ${
        existingWebhook ? "updated" : "created"
      } for repository ${GITHUB_REPO}`
    );
    return data.id;
  } catch (error: any) {
    console.error(
      `❌ Failed to update or create GitHub webhook:`,
      error.message
    );
    process.exit(1);
  }
}

async function setupWebhookPipeline() {
  console.log("🚀 Setting up the GitHub → Hookdeck → PostHog pipeline...");

  const source = await createSource();
  const destinationId = await createDestination();
  await createConnection(source.id, destinationId);
  await createGitHubWebhook(source.url);

  console.log("🎉 Webhook pipeline successfully set up!");
}

/**
 * Main application function
 */
async function main() {
  console.log("GitHub Stars to PostHog application starting...");
  await setupWebhookPipeline();
}

// Run the application
main().catch((error) => {
  console.error("Error in main application:", error);
  process.exit(1);
});
