// Sends emails via Resend (resend.com). Free tier covers a small monthly
// digest with room to spare.

export async function sendEmail(toEmail, subject, htmlBody) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody
    })
  });
  if (!res.ok) {
    throw new Error(`Resend API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

const STAR_DISPLAY = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

// Sends an immediate alert for a 1-2 star review, separate from the monthly
// digest - the whole point is not waiting weeks to find out about it.
export async function sendUrgentReviewAlert(business, review) {
  const stars = STAR_DISPLAY[review.starRating] || "?";
  const dashboardUrl = `${process.env.BASE_URL}/`;
  const html = `
    <p style="font-size:14px; color:#D64545; font-weight:700; margin:0 0 10px;">⚠ New ${stars}-star review needs your attention</p>
    <p style="font-size:14px; margin:0 0 10px;"><strong>${business.businessName}</strong> just received a ${stars}-star review${review.reviewer ? " from " + review.reviewer : ""}:</p>
    <p style="font-size:14px; font-style:italic; background:#f5f5f2; padding:12px 14px; border-radius:8px; margin:0 0 14px;">"${review.comment}"</p>
    <p style="font-size:14px; margin:0 0 14px;">A reply has already been drafted and is waiting for your approval in your dashboard.</p>
    <p><a href="${dashboardUrl}" style="display:inline-block; background:#14213D; color:#fff; padding:10px 18px; border-radius:7px; font-size:14px; text-decoration:none;">Review and respond</a></p>
  `;
  try {
    await sendEmail(business.email, `⚠ New ${stars}-star review for ${business.businessName}`, html);
  } catch (err) {
    console.error(`[emailer] Failed to send urgent review alert to ${business.email}:`, err.message);
  }
}
