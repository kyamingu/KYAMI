
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

const ALLOWED_ORIGINS = new Set([
  "https://kyami-ai.aimraneoubram.workers.dev",
  "https://kyamingu.github.io"
]);

function json(data, status = 200, origin = null, ownOrigin = null) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  });

  const allowed = origin === null
    ? ownOrigin
    : (ALLOWED_ORIGINS.has(origin) ? origin : null);

  if (allowed) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
  }

  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const ownOrigin = url.origin;

    if (url.pathname.startsWith("/api/")) {
      if (origin && origin !== ownOrigin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: "Origin not allowed." }, 403, origin, ownOrigin);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin || ownOrigin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin"
          }
        });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          status: "ok",
          provider: "Cloudflare Workers AI",
          model: MODEL
        }, 200, origin, ownOrigin);
      }

      if (url.pathname === "/api/models" && request.method === "GET") {
        return json({ models: [MODEL] }, 200, origin, ownOrigin);
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        try {
          const body = await request.json();
          const input = body?.messages;

          if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
            return json({
              error: "Send between 1 and 20 messages."
            }, 400, origin, ownOrigin);
          }

          let totalLength = 0;
          const messages = [];

          for (const item of input) {
            if (
              !item ||
              !["user", "assistant"].includes(item.role) ||
              typeof item.text !== "string"
            ) {
              return json({ error: "Invalid message format." }, 400, origin, ownOrigin);
            }

            const content = item.text.trim();

            if (!content || content.length > 8000) {
              return json({
                error: "Each message must contain 1 to 8000 characters."
              }, 400, origin, ownOrigin);
            }

            totalLength += content.length;

            if (totalLength > 30000) {
              return json({ error: "Conversation is too long." }, 400, origin, ownOrigin);
            }

            messages.push({
              role: item.role,
              content
            });
          }

          if (messages[messages.length - 1].role !== "user") {
            return json({
              error: "The last message must be from the user."
            }, 400, origin, ownOrigin);
          }

          const result = await env.AI.run(MODEL, {
            messages: [
              {
                role: "system",
                content: "You are KYAMI, a helpful and thoughtful AI assistant. Match the language of the user. When the user writes in Moroccan Darija, answer naturally in Moroccan Darija. Be clear, accurate, friendly, and honest."
              },
              ...messages
            ],
            max_tokens: 1024,
            chat_template_kwargs: {
              enable_thinking: false
            }
          });

          const reply =
            result?.choices?.[0]?.message?.content ??
            result?.response ??
            "";

          if (typeof reply !== "string" || !reply.trim()) {
            return json({
              error: "KYAMI could not generate a response. Please try again."
            }, 502, origin, ownOrigin);
          }

          return json({
            reply: reply.trim(),
            model: MODEL
          }, 200, origin, ownOrigin);

        } catch (error) {
          console.error("KYAMI AI error:", error?.message || "Unknown error");

          return json({
            error: "KYAMI AI is temporarily unavailable. Please try again."
          }, 503, origin, ownOrigin);
        }
      }

      return json({ error: "API route not found." }, 404, origin, ownOrigin);
    }

    return env.ASSETS.fetch(request);
  }
};
