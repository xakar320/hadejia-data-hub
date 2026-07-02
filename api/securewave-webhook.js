import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {

    // Raw body
    const body =
      typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    // Signature from SecureWave
    const signature =
      req.headers["x-signature"] ||
      req.headers["x-securewave-signature"] ||
      "";

    // Secret
    const secret =
      process.env.SECUREWAVE_WEBHOOK_SECRET;

    // Generate HMAC SHA256
    const hash = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // Verify signature
    if (signature !== hash) {
      return res.status(401).json({
        success: false,
        message: "Invalid signature"
      });
    }

    const payload =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    console.log("Webhook Payload:", payload);

    return res.status(200).json({
      success: true
    });

  } catch (err) {

    console.log(err);

    return res.status(500).json({
      success: false,
      message: err.message
    });

  }

}
