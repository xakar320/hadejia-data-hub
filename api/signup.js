import { createClient } from "@supabase/supabase-js";

const admin = createClient(
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
    const {
      fullName,
      phone,
      email,
      password,
      pin
    } = req.body;

    if (!fullName || !phone || !email || !password || !pin) {
      return res.status(400).json({
        success: false,
        message: "All fields are required."
      });
    }

    const userEmail = email.trim().toLowerCase();

    // Create Auth User
    const { data, error } = await admin.auth.admin.createUser({
      email: userEmail,
      password,
      email_confirm: true
    });

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    const authUser = data.user;

    // Check if already exists in users table
    const { data: existing } = await admin
      .from("users")
      .select("id")
      .eq("id", authUser.id)
      .maybeSingle();

    if (!existing) {
      const { error: insertError } = await admin
        .from("users")
        .insert({
          id: authUser.id,
          account_name: fullName,
          email: userEmail,
          phone,
          pin,
          balance: 0,
          is_admin: false
        });

      if (insertError) {
        await admin.auth.admin.deleteUser(authUser.id);

        return res.status(400).json({
          success: false,
          message: insertError.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Account created successfully."
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
}
