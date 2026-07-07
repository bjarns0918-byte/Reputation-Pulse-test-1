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
  return data.content.map((b) => b.text || "").join("\n").trim();
}

export async function draftAutoPostReply(review, bizName, tone) {
  const starText = STAR_WORDS[review.starRating] || review.starRating;
  const prompt =
    `You are writing an owner reply to a positive customer review for a small business called "${bizName}". ` +
    `Reply tone should be: ${tone}. ` +
    `The review is ${starText}. Reviewer wrote: "${review.comment}"\n\n` +
    `Write ONE short reply (2-3 sentences), warm and specific, referencing something from the review. ` +
    `This reply will be posted publicly and automatically, so it must be safe, genuine, and never overpromise anything. ` +
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

  const raw = await callClaude(prompt, 1200);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
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
    `Do not use generic corporate phrases like "we value your feedback". Output only the two labeled options, nothing else.`;

  const result = await callClaude(prompt);
  const opt1 = (result.split(/OPTION 2:/i)[0] || "").replace(/OPTION 1:/i, "").trim();
  const opt2 = (result.split(/OPTION 2:/i)[1] || "").trim();
  return [opt1, opt2];
}

export async function buildDigest(reviews, bizName) {
  const listText = reviews
    .map((r, i) => `${i + 1}. (${STAR_WORDS[r.starRating] || r.starRating}) ${r.comment}`)
    .join("\n");

  const prompt =
    `You are summarizing a batch of customer reviews for a small business called "${bizName}" ` +
    `so the owner, who has no time to read every review, understands what is actually going on. ` +
    `Here are the reviews from the past month:\n${listText}\n\n` +
    `Write a short digest (5-8 sentences max) in plain, direct, friendly English, like a trusted friend giving them the highlights. ` +
    `Call out recurring themes (both good and bad), specific staff members if named, and anything that needs urgent attention. ` +
    `Do not just restate every review. Do not use bullet points or headers, write it as flowing plain text. No corporate language.`;

  return callClaude(prompt);
}
