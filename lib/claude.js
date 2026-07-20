// Calls the real Anthropic API. This runs on your server, not in a browser,
// so your ANTHROPIC_API_KEY stays private - it's never sent to the client.

const STAR_WORDS = {
  ONE: "1 star",
  TWO: "2 stars",
  THREE: "3 stars",
  FOUR: "4 stars",
  FIVE: "5 stars"
};

async function callClaude(prompt, maxTokens = 1000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    throw new Error(`Claude API error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("\n").trim();
  if (!text) {
    // This shouldn't normally happen on a successful (200 OK) response, so
    // log the full response to make the cause obvious if it happens again.
    console.error(
      `[claude] Got an empty response despite a 200 OK. stop_reason: ${data.stop_reason}, full response:\n${JSON.stringify(data)}`
    );
  }
  return text;
}

// Parses JSON out of a Claude response, tolerating stray text or markdown
// fences around it, and giving a clear error instead of a cryptic one if
// the response was cut off or otherwise not valid JSON.
function parseJsonResponse(raw) {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Fall back to finding the first balanced [...] or {...} block, properly
    // tracking string literals so brackets inside quoted text don't confuse it.
    const start = cleaned.search(/[[{]/);
    if (start === -1) throw err;

    const open = cleaned[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(cleaned.slice(start, i + 1));
        }
      }
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls Claude and parses its JSON response, retrying automatically if the
// first attempt comes back cut off, empty, or malformed - this resolves the
// large majority of occasional truncation or transient-overload issues.
async function callClaudeForJson(prompt, maxTokens, contextLabel) {
  let lastRaw = "";
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await callClaude(prompt, maxTokens);
    lastRaw = raw;
    try {
      if (!raw) throw new Error("empty response");
      return parseJsonResponse(raw);
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error(`[claude] Giving up parsing JSON for ${contextLabel} after ${maxAttempts} attempts. Last raw response was:\n${lastRaw}`);
        throw new Error(`Claude's response for ${contextLabel} got cut off or wasn't valid after retrying. Please try again.`);
      }
      console.warn(`[claude] JSON parse failed for ${contextLabel} on attempt ${attempt}, retrying...`);
      await sleep(500);
    }
  }
}

export async function draftAutoPostReply(review, bizName, tone) {
  const starText = STAR_WORDS[review.starRating] || review.starRating;
  const prompt =
    `You are writing an owner reply to a positive customer review for a small business called "${bizName}". ` +
    `Reply tone should be: ${tone}. ` +
    `The review is ${starText}. Reviewer wrote: "${review.comment}"\n\n` +
    `Write ONE short reply (2-3 sentences), warm and specific, referencing something from the review. ` +
    `This reply will be posted publicly and automatically, so it must be safe, genuine, and never overpromise anything. ` +
    `Write your reply in the SAME language the reviewer wrote in (if the review is in Spanish, reply in Spanish; if French, reply in French; and so on). ` +
    `Do not use generic corporate phrases like "we value your feedback". Output only the reply text, nothing else - no labels, no quotation marks.`;

  return callClaude(prompt, 300);
}

export async function generateSampleReviews(businessName) {
  const prompt =
    `Generate 8 realistic-sounding customer reviews for a small local restaurant called "${businessName}". ` +
    `Mix of star ratings: include roughly 4 reviews at 5 stars, 1 at 4 stars, 1 at 3 stars, 1 at 2 stars, and 1 at 1 star. ` +
    `Make them sound like real Google review comments - varied length, some short, some longer, mentioning specific ` +
    `things like food items, service, wait times, staff names, or price where natural. Do not make every review about ` +
    `the same topic. Output ONLY a valid JSON array, no other text, no markdown fences, in this exact shape: ` +
    `[{"stars": 5, "reviewer": "First Last initial.", "comment": "review text"}, ...]`;

  return callClaudeForJson(prompt, 2200, "the sample reviews");
}

export async function draftReply(review, bizName, tone) {
  const starText = STAR_WORDS[review.starRating] || review.starRating;
  const prompt =
    `You are writing owner replies to a customer review for a small business called "${bizName}". ` +
    `Reply tone should be: ${tone}. ` +
    `The review is ${starText}. Reviewer wrote: "${review.comment}"\n\n` +
    `Write two short reply options (2-4 sentences each), labeled exactly "OPTION 1:" and "OPTION 2:". ` +
    `If the review is negative, make replies calm and de-escalating without being defensive, and invite the customer to follow up privately. ` +
    `If the review is positive, make replies warm and specific, referencing something from the review. ` +
    `Write both options in the SAME language the reviewer wrote in (if the review is in Spanish, reply in Spanish; if French, reply in French; and so on) - keep the "OPTION 1:" and "OPTION 2:" labels themselves in English so they can still be parsed correctly. ` +
    `Do not use generic corporate phrases like "we value your feedback". Output only the two labeled options, nothing else.`;

  const result = await callClaude(prompt);
  const opt1 = (result.split(/OPTION 2:/i)[0] || "").replace(/OPTION 1:/i, "").trim();
  const opt2 = (result.split(/OPTION 2:/i)[1] || "").trim();
  return [opt1, opt2];
}

export async function extractThemes(reviews, bizName) {
  const listText = reviews
    .map((r, i) => `${i + 1}. (${STAR_WORDS[r.starRating] || r.starRating}) ${r.comment}`)
    .join("\n");

  const prompt =
    `Read these customer reviews for "${bizName}" and identify the 3-5 most notable recurring themes ` +
    `(e.g. wait times, staff friendliness, food quality, pricing, cleanliness, order accuracy). ` +
    `Here are the reviews:\n${listText}\n\n` +
    `Output ONLY valid JSON, no markdown fences, no other text, as an array in this exact shape: ` +
    `[{"theme": "wait times", "sentiment": "negative", "mentions": 2}]. ` +
    `"sentiment" must be exactly the word "positive" or "negative" - pick whichever the theme skews toward overall. ` +
    `"mentions" is how many of the reviews touched on that theme. Only include themes clearly present in at least one ` +
    `review. Order the array by mentions, highest first.`;

  return callClaudeForJson(prompt, 900, "the sentiment themes");
}

export async function buildDigest(reviews, bizName) {
  const listText = reviews
    .map((r, i) => `${i + 1}. (${STAR_WORDS[r.starRating] || r.starRating}) ${r.comment}`)
    .join("\n");

  const prompt =
    `You are writing a monthly reputation summary for the owner of a small business called "${bizName}". ` +
    `The owner does not have time to read every review individually. Here are the reviews from the past month:\n${listText}\n\n` +
    `Write two short sections, in plain, simple, business-appropriate English - measured and professional, not casual. ` +
    `Output ONLY valid JSON, no markdown fences, no other text, in this exact shape:\n` +
    `{"strengths": "2-4 sentences on what's working well, naming staff only if mentioned by name in the reviews", ` +
    `"improvements": "2-4 sentences on recurring issues or anything needing prompt attention, phrased constructively, not harshly"}\n\n` +
    `Do not restate every review individually. Do not use bullet points, headers, emojis, or exclamation points. ` +
    `Each section should read as flowing plain text only. If there is truly nothing negative, improvements can note ` +
    `that overall performance was strong with only minor, low-stakes notes.`;

  return callClaudeForJson(prompt, 900, "the digest");
}
