import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, supabaseServiceRole);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const { fullName, phone, email, password, pin } = req.body || {};

    // Validation
    if (!fullName || !phone || !email || !password || !pin) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    if (String(phone).length < 11) {
      return res.status(400).json({
        success: false,
        message: "Phone number must be at least 11 digits"
      });
    }

    if (String(pin).length !== 4) {
      return res.status(400).json({
        success: false,
        message: "PIN must be exactly 4 digits"
      });
    }

    // 1) Create user in Supabase Auth
    const { data: signUpData, error: signUpError } = await admin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true
    });

    if (signUpError) {
      return res.status(400).json({
        success: false,
        message: signUpError.message
      });
    }

    const authUser = signUpData.user;
    if (!authUser) {
      return res.status(500).json({
        success: false,
        message: "User creation failed"
      });
    }

    // 2) Insert into users table
    const { error: insertError } = await admin.from("users").insert([
      {
        id: authUser.id,
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        account_name: fullName.trim(),
        pin: pin.trim(),
        balance: 0,
        is_admin: false
      }
    ]);

    if (insertError) {
      // rollback auth user if insert fails
      try {
        await admin.auth.admin.deleteUser(authUser.id);
      } catch (_) {}

      return res.status(400).json({
        success: false,
        message: insertError.message
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account created successfully"
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Server error"
    });
  }
}
