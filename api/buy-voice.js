import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VOICE_PLAN_PRICES = {
  "26117793": { name: "MTN Voice Bundle", price: 120, network: "MTN" },
  "26117794": { name: "AIRTEL Voice Bundle", price: 100, network: "AIRTEL" }
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

    const plan = VOICE_PLAN_PRICES[plan_id];
    if (!plan) {
      return res.status(400).json({
        status: false,
        message: "Unknown voice plan"
      });
    }

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

    const autosyncResponse = await fetch("https://autosyncng.com/api/voice/transfer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AUTOSYNC_API_KEY}`
      },
      body: JSON.stringify({
        request_ref: request_ref || `VOICE_${Date.now()}`,
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
        message: autosyncResult.message || "Voice purchase failed",
        provider_response: autosyncResult
      });
    }

    const newBalance = currentBalance - planPrice;

    const { error: updateError } = await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("id", user.id);

    if (updateError) {
      return res.status(500).json({
        status: false,
        message: "Voice purchased but wallet update failed",
        error: updateError.message
      });
    }

    const { error: txError } = await supabase
      .from("transactions")
      .insert([
        {
          user_id: user.id,
          type: "Voice Bundle",
          details: `${plan.network} ${plan.name} to ${phone}`,
          amount: planPrice,
          status: "Success"
        }
      ]);

    if (txError) {
      return res.status(500).json({
        status: false,
        message: "Voice bought but transaction insert failed",
        error: txError.message
      });
    }

    return res.status(200).json({
      status: true,
      message: "Voice bundle purchased successfully",
      balance_before: currentBalance,
      balance_after: newBalance,
      plan,
      provider_response: autosyncResult
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message || "Server error buying voice"
    });
  }
        }
