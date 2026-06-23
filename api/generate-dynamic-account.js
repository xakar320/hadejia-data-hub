export default async function handler(req, res) {
  // Allow only POST
  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      email,
      first_name,
      last_name,
      phone_number,
      bank_code,
      amount
    } = req.body || {};

    // Basic validation
    if (!email || !first_name || !last_name || !phone_number || !amount || !bank_code) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields"
      });
    }

    // Get secrets from Vercel Environment Variables
    const baseURL = process.env.SECUREWAVE_BASE_URL;
    const secretKey = process.env.SECUREWAVE_SECRET_KEY;
    const publicKey = process.env.SECUREWAVE_PUBLIC_KEY;
    const businessId = process.env.SECUREWAVE_BUSINESS_ID;

    if (!baseURL || !secretKey || !publicKey || !businessId) {
      return res.status(500).json({
        status: false,
        message: "Server environment variables are missing"
      });
    }

    const payload = {
      email,
      first_name,
      last_name,
      phone_number,
      bank_code: [Number(bank_code)],
      business_id: businessId,
      account_type: "dynamic",
      amount: Number(amount)
    };

    const response = await fetch(`${baseURL}/dynamic_accounts/generate`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secretKey}`,
        "x-api-key": publicKey
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      data = {
        status: false,
        message: "Invalid JSON response from upstream API",
        raw: rawText
      };
    }

    return res.status(response.status).json(data);

  } catch (error) {
    console.error("Dynamic account error:", error);
    return res.status(500).json({
      status: false,
      message: "Internal server error",
      error: error.message
    });
  }
}
