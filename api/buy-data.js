import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Saka farashin plans ɗin ka a backend domin a hana user ya canza price daga browser
const DATA_PLAN_PRICES = {
  "26117253": { name: "MTN 1GB Daily Awoof", price: 300, network: "MTN" },
  "26117607": { name: "MTN 1GB 7days", price: 450, network: "MTN" },
  "26117598": { name: "MTN 500MB 30days", price: 350, network: "MTN" },
  "26117599": { name: "MTN 1GB 30days", price: 570, network: "MTN" },
  "26117600": { name: "MTN 2GB 30days", price: 1140, network: "MTN" },
  "26117601": { name: "MTN 3GB 30days", price: 1710, network: "MTN" },
  "26117602": { name: "MTN 5GB 30days", price: 2850, network: "MTN" },

  "26117381": { name: "AIRTEL Awoof 1.5GB", price: 450, network: "AIRTEL" },
  "26117567": { name: "GLO 1GB 30days", price: 400, network: "GLO" },
  "9M1GB": { name: "9MOBILE SME 1GB", price: 180, network: "9MOBILE" }
};

export default async function handler(req, res) {
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
      user_id,
      phone,
      network,
      variation_code,
      plan_id,
      request_ref,
      pin
    } = req.body || {};

    if (!user_id || !phone || !network || !variation_code || !plan_id) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields"
      });
    }

    if (String(phone).length < 11) {
      return res.status(400).json({
        status: false,
        message: "Invalid phone number"
      });
    }

    const plan = DATA_PLAN_PRICES[plan_id];
    if (!plan) {
      return res.status(400).json({
        status: false,
        message: "Unknown data plan"
      });
    }

    // Nemi user
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, balance, transaction_pin, account_name, email")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: false,
        message: "User not found"
      });
    }

    // Idan kana son a duba transaction pin
    if (user.transaction_pin && String(user.transaction_pin) !== String(pin)) {
      return res.status(401).json({
        status: false,
        message: "Invalid transaction PIN"
      });
    }

    const currentBalance = Number(user.balance || 0);
    const planPrice = Number(plan.price);

    if (currentBalance < planPrice) {
      return res.status(400).json({
        status: false,
        message: "Insufficient wallet balance"
      });
    }

    // Kira Autosync
    const autosyncResponse = await fetch("https://autosyncng.com/api/data/transfer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AUTOSYNC_API_KEY}`
      },
      body: JSON.stringify({
        request_ref: request_ref || `DATA_${Date.now()}`,
        phone,
        network: String(network).toLowerCase(),
        variation_code,
        plan_id,
        ported_no: false,
        pin: "2098"
      })
    });

    const autosyncResult = await autosyncResponse.json();

    const success =
      autosyncResult.status === "ok" ||
      autosyncResult.success === true ||
      autosyncResult.code === 200;

    if (!success) {
      return res.status(400).json({
        status: false,
        message: autosyncResult.message || "Data purchase failed",
        provider_response: autosyncResult
      });
    }

    const newBalance = currentBalance - planPrice;

    // Deduct wallet
    const { error: updateError } = await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("id", user.id);

    if (updateError) {
      return res.status(500).json({
        status: false,
        message: "Purchase successful but failed to update wallet",
        error: updateError.message
      });
    }

    // Insert transaction
    const { error: txError } = await supabase
      .from("transactions")
      .insert([
        {
          user_id: user.id,
          type: "Data",
          details: `${plan.network} ${plan.name} to ${phone}`,
          amount: planPrice,
          status: "Success"
        }
      ]);

    if (txError) {
      return res.status(500).json({
        status: false,
        message: "Data bought but transaction insert failed",
        error: txError.message
      });
    }

    return res.status(200).json({
      status: true,
      message: "Data purchased successfully",
      balance_before: currentBalance,
      balance_after: newBalance,
      plan,
      provider_response: autosyncResult
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message || "Server error buying data"
    });
  }
        }
