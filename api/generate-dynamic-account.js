export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      message: "Method not allowed. Use POST."
    });
  }

  try {
    const {
      email,
      first_name,
      last_name,
      phone_number,
      amount,
      bank_code
    } = req.body || {};

    if (!email || !first_name || !last_name || !phone_number || !amount) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields"
      });
    }

    const payload = {
      email,
      first_name,
      last_name,
      phone_number,
      bank_code: Array.isArray(bank_code) && bank_code.length ? bank_code : [3],
      business_id: process.env.SECUREWAVE_BUSINESS_ID,
      account_type: "dynamic",
      amount: Number(amount)
    };

    const response = await fetch(`${process.env.SECUREWAVE_BASE_URL}/dynamic_accounts/generate`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SECUREWAVE_SECRET_KEY}`,
        "x-api-key": process.env.SECUREWAVE_PUBLIC_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    return res.status(response.ok ? 200 : 400).json(data);
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message || "Server error generating dynamic account"
    });
  }
}
