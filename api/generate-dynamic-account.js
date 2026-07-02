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
      message: "Method not allowed"
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

    // ENV
    const SECRET_KEY = process.env.SECUREWAVE_SECRET_KEY;
    const PUBLIC_KEY = process.env.SECUREWAVE_PUBLIC_KEY;
    const BUSINESS_ID = process.env.SECUREWAVE_BUSINESS_ID;

    if (!SECRET_KEY || !PUBLIC_KEY || !BUSINESS_ID) {
      return res.status(500).json({
        status: false,
        message: "Server environment variables are missing"
      });
    }

    // VALIDATION
    if (
      !email ||
      !first_name ||
      !last_name ||
      !phone_number ||
      !amount
    ) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields",
        debug: {
          email: !!email,
          first_name: !!first_name,
          last_name: !!last_name,
          phone_number: !!phone_number,
          amount: !!amount
        }
      });
    }

    const payload = {
      email,
      first_name,
      last_name,
      phone_number,
      bank_code: Array.isArray(bank_code) && bank_code.length ? bank_code : [3],
      business_id: BUSINESS_ID,
      account_type: "dynamic",
      amount: Number(amount)
    };

    const response = await fetch(
  "https://securewaveng.com/api/dynamic_accounts/generate", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SECRET_KEY}`,
        "x-api-key": PUBLIC_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    return res.status(response.status).json(data);

  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message || "Internal server error"
    });
  }
}
