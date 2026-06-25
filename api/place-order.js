export default async function handler(req, res) {
  // =========================
  // ALLOW ONLY POST
  // =========================
  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      message: "Method not allowed. Use POST."
    });
  }

  try {
    // =========================
    // GET BODY DATA
    // =========================
    const {
      serviceType,      // "data" or "voice"
      network,          // MTN / AIRTEL / GLO / 9MOBILE
      phone,
      variation_code,
      plan_id,
      amount,
      plan_name
    } = req.body || {};

    // =========================
    // BASIC VALIDATION
    // =========================
    if (!serviceType || !["data", "voice"].includes(serviceType)) {
      return res.status(400).json({
        status: false,
        message: "Invalid serviceType. Use data or voice."
      });
    }

    if (!network) {
      return res.status(400).json({
        status: false,
        message: "Network is required."
      });
    }

    if (!phone || !/^0\d{10}$/.test(phone)) {
      return res.status(400).json({
        status: false,
        message: "Valid 11-digit phone number is required."
      });
    }

    if (!variation_code) {
      return res.status(400).json({
        status: false,
        message: "variation_code is required."
      });
    }

    if (!plan_id) {
      return res.status(400).json({
        status: false,
        message: "plan_id is required."
      });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        status: false,
        message: "Invalid amount."
      });
    }

    // =========================
    // ENVIRONMENT VARIABLES
    // =========================
    const AUTOSYNC_API_KEY = process.env.AUTOSYNC_API_KEY;

    if (!AUTOSYNC_API_KEY) {
      return res.status(500).json({
        status: false,
        message: "Missing AUTOSYNC_API_KEY in environment variables."
      });
    }

    // =========================
    // NORMALIZE NETWORK
    // =========================
    const normalizedNetwork = String(network).trim().toLowerCase();

    // =========================
    // SELECT AUTOSYNC ENDPOINT
    // =========================
    let autosyncUrl = "";

    if (serviceType === "data") {
      autosyncUrl = "https://autosyncng.com/api/data/transfer";
    } else {
      autosyncUrl = "https://autosyncng.com/api/voice/transfer";
    }

    // =========================
    // REQUEST REF
    // =========================
    const request_ref =
      "REF_" +
      serviceType.toUpperCase() +
      "_" +
      Date.now() +
      "_" +
      Math.floor(Math.random() * 100000);

    // =========================
    // BUILD AUTOSYNC PAYLOAD
    // =========================
    const payload = {
      request_ref,
      phone,
      network: normalizedNetwork,
      variation_code,
      plan_id,
      ported_no: false
    };

    // =========================
    // CALL AUTOSYNC
    // =========================
    const apiResponse = await fetch(autosyncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTOSYNC_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    let apiResult = null;
    try {
      apiResult = await apiResponse.json();
    } catch (jsonErr) {
      return res.status(500).json({
        status: false,
        message: "Autosync returned invalid JSON response.",
        raw: null
      });
    }

    // =========================
    // SUCCESS CHECK
    // =========================
    const success =
      apiResponse.ok &&
      (
        apiResult?.status === "ok" ||
        apiResult?.status === true ||
        apiResult?.success === true ||
        apiResult?.code === "success" ||
        apiResult?.message?.toLowerCase?.().includes("success")
      );

    if (!success) {
      return res.status(400).json({
        status: false,
        message:
          apiResult?.message ||
          apiResult?.response_description ||
          `Failed to ${serviceType === "data" ? "buy data" : "buy voice bundle"}.`,
        raw: apiResult
      });
    }

    // =========================
    // SUCCESS RESPONSE TO FRONTEND
    // =========================
    return res.status(200).json({
      status: true,
      message:
        serviceType === "data"
          ? "Data purchase successful"
          : "Voice bundle purchase successful",
      data: {
        request_ref,
        serviceType,
        network,
        phone,
        variation_code,
        plan_id,
        plan_name: plan_name || "",
        amount: Number(amount),
        provider_response: apiResult
      }
    });

  } catch (error) {
    console.error("PLACE ORDER ERROR:", error);

    return res.status(500).json({
      status: false,
      message: error.message || "Internal server error"
    });
  }
  }
