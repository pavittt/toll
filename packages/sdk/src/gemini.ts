/**
 * Minimal Google Gemini REST client (free tier works). Used when GEMINI_API_KEY is set and
 * ANTHROPIC_API_KEY is not, so the whole project can run without paying for an AI API.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export const geminiModel = () => process.env.GEMINI_MODEL ?? "gemini-flash-latest";
export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** OpenAPI-style schema accepted by Gemini's responseSchema / function parameters. */
export type GeminiSchema = {
  type: "OBJECT" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
};

export type GeminiRequest = {
  system?: string;
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: GeminiSchema }> }>;
  responseSchema?: GeminiSchema;
  temperature?: number;
};

export type GeminiResponse = {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
};

export async function geminiGenerate(req: GeminiRequest): Promise<GeminiResponse> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const body: Record<string, unknown> = { contents: req.contents };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools) body.tools = req.tools;
  const generationConfig: Record<string, unknown> = {};
  if (req.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = req.responseSchema;
  }
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(geminiModel())}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      // Free tier rate limits: back off and retry.
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    const json = (await res.json()) as GeminiResponse & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${json.error?.message ?? "unknown"}`);
    return json;
  }
  throw new Error("Gemini is rate limiting requests. Wait a minute and try again.");
}

/** Returns parsed JSON that follows `schema`, or null if the model gave none. */
export async function geminiJson(system: string, user: string, schema: GeminiSchema): Promise<unknown | null> {
  const res = await geminiGenerate({ system, contents: [{ role: "user", parts: [{ text: user }] }], responseSchema: schema, temperature: 0 });
  const text = res.candidates?.[0]?.content?.parts
    ?.map((p) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
