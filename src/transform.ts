interface Request {
  headers: { [key: string]: string };
  body: any;
}

interface GitHubStarEvent {
  action: string; // "created" or "deleted"
  starred_at?: string; // ISO 8601 timestamp (present when action is "created")
  repository: {
    id: number;
    full_name: string;
    html_url: string;
    stargazers_count: number;
  };
  sender: {
    login: string;
    html_url: string;
  };
}

type HandlerFunction = (request: Request, context: any) => Request;

// Define the addHandler function type
interface AddHandlerFunction {
  (name: string, handler: HandlerFunction): void;
}

// Declare addHandler as a function matching the interface
declare const addHandler: AddHandlerFunction;

addHandler("transform", (request: Request, context: any) => {
  const gitHubStarEvent = request.body as GitHubStarEvent;
  const { repository, sender, action, starred_at } = gitHubStarEvent;

  // Determine count value based on action
  const count = action === "created" ? 1 : -1;

  const transformedBody = {
    event: `GitHub Star`,
    api_key: process.env.POSTHOG_API_KEY,
    distinct_id: sender.login,
    properties: {
      repo_name: repository.full_name,
      repo_url: repository.html_url,
      stargazer_username: sender.login,
      stargazer_profile: sender.html_url,
      star_count: repository.stargazers_count,
      action: action,
      starred_at: starred_at || null,
      count: count,
    },
  };

  request.body = transformedBody;
  return request;
});

export default addHandler;
