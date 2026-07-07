// Sends emails via Resend (resend.com). Free tier covers a small monthly
// digest with room to spare.

export async function sendEmail(subject, htmlBody) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: process.env.OWNER_EMAIL,
      subject,
      html: htmlBody
    })
  });
  if (!res.ok) {
    throw new Error(`Resend API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
