import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // GET domin ka gwada route yana aiki
  if (req.method === "GET") {
    return res.status(200).json({
      status: true,
      message: "SecureWave webhook endpoint is active"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      message: "Method not allowed"
    });
  }

  try {
    const payload = req.body || {};
    console.log("SECUREWAVE WEBHOOK:", JSON.stringify(payload, null, 2));

    // Duba possible fields daga webhook
    const customerEmail =
      payload.customer?.email ||
      payload.email ||
      payload.account_email ||
      payload.data?.customer?.email ||
      payload.data?.email ||
      payload.data?.account_email ||
      null;

    const amountPaid =
      Number(payload.amount) ||
      Number(payload.data?.amount) ||
      Number(payload.amount_paid) ||
      Number(payload.data?.amount_paid) ||
      0;

    const status =
      payload.notification_status ||
      payload.status ||
      payload.payment_status ||
      payload.data?.status ||
      payload.data?.notification_status ||
      null;

    const transactionRef =
      payload.provider_reference ||
      payload.transaction_id ||
      payload.account_reference ||
      payload.reference ||
      payload.data?.provider_reference ||
      payload.data?.transaction_id ||
      payload.data?.account_reference ||
      payload.data?.reference ||
      `SECUREWAVE_${Date.now()}`;

    // Za ka iya cire wannan fee idan kana so
    // Misali idan SecureWave ya caji fee kuma kana son user ya samu less fee:
    const fee = 0;
    const amountToCredit = Math.max(0, amountPaid - fee);

    // Duba success status
    const isSuccess =
      status === "payment_success" ||
      status === "success" ||
      status === "successful" ||
      status === 1 ||
      status === "1" ||
      payload.event === "payment.success" ||
      payload.data?.event === "payment.success";

    if (!customerEmail) {
      return res.status(400).json({
        status: false,
        message: "Webhook received but no customer email found"
      });
    }

    if (!isSuccess) {
      return res.status(200).json({
        status: true,
        message: "Webhook received but payment not successful yet",
        email: customerEmail,
        payment_status: status
      });
    }

    if (!amountToCredit || amountToCredit <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid amount from webhook"
      });
    }

    // Nemi user ta email
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, balance, email, account_name")
      .eq("email", customerEmail)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: false,
        message: "User not found for this email",
        email: customerEmail
      });
    }

    // Duba duplicate transaction
    const { data: existingTx } = await supabase
      .from("transactions")
      .select("id")
      .eq("details", `Ref: ${transactionRef}`)
      .maybeSingle();

    if (existingTx) {
      return res.status(200).json({
        status: true,
        message: "Transaction already processed",
        transaction_ref: transactionRef
      });
    }

    const currentBalance = Number(user.balance || 0);
    const newBalance = currentBalance + amountToCredit;

    // Update user balance
    const { error: updateError } = await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("id", user.id);

    if (updateError) {
      return res.status(500).json({
        status: false,
        message: "Failed to update wallet balance",
        error: updateError.message
      });
    }

    // Insert transaction
    const { error: txError } = await supabase
      .from("transactions")
      .insert([
        {
          user_id: user.id,
          type: "Wallet Funding",
          details: `Ref: ${transactionRef}`,
          amount: amountToCredit,
          status: "Success"
        }
      ]);

    if (txError) {
      return res.status(500).json({
        status: false,
        message: "Balance updated but transaction insert failed",
        error: txError.message
      });
    }

    return res.status(200).json({
      status: true,
      message: "Wallet funded successfully from SecureWave webhook",
      credited_amount: amountToCredit,
      user_email: customerEmail,
      transaction_ref: transactionRef
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({
      status: false,
      message: error.message || "Webhook server error"
    });
  }
}
