// ==============================================
// Hadejia Data Hub
// api/place-order.js
// Part 3D-2A
// ==============================================

import { createClient } from "@supabase/supabase-js";

// ==============================================
// SUPABASE
// ==============================================

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==============================================
// API HANDLER
// ==============================================

export default async function handler(req, res) {

    // Allow POST only
    if (req.method !== "POST") {

        return res.status(405).json({

            success: false,

            message: "Method Not Allowed"

        });

    }

    try {

        // ======================================
        // GET BODY
        // ======================================

        const {

            user_id,

            phone,

            product_id,

            variation_code,

            amount,

            request_ref

        } = req.body;

        // ======================================
        // VALIDATION
        // ======================================

        if (!user_id) {

            return res.status(400).json({

                success: false,

                message: "User ID is required"

            });

        }

        if (!phone) {

            return res.status(400).json({

                success: false,

                message: "Phone Number is required"

            });

        }

        if (!product_id) {

            return res.status(400).json({

                success: false,

                message: "Product ID is required"

            });

        }

        if (!variation_code) {

            return res.status(400).json({

                success: false,

                message: "Variation Code is required"

            });

        }

        if (!amount) {

            return res.status(400).json({

                success: false,

                message: "Amount is required"

            });

        }

        // Generate Request Ref if empty

        const requestReference =
            request_ref ||
            "HDH-" +
            Date.now();

        // ======================================
        // GET USER
        // ======================================

        const {

            data: user,

            error: userError

        } = await supabase

            .from("users")

            .select("*")

            .eq("id", user_id)

            .single();

        if (userError || !user) {

            return res.status(404).json({

                success: false,

                message: "User not found"

            });

        }

        // ======================================
        // USER ACTIVE?
        // ======================================

        if (user.status === "blocked") {

            return res.status(403).json({

                success: false,

                message:
                "Account has been blocked"

            });

        }

        // ======================================
        // CONTINUE TO PART 3D-2B
        // ======================================

        // ======================================
// CHECK DUPLICATE REQUEST
// ======================================

const { data: duplicate } = await supabase

.from("transactions")

.select("id,status")

.eq("request_ref", requestReference)

.maybeSingle();

if (duplicate) {

    return res.status(409).json({

        success: false,

        message: "Duplicate request reference"

    });

}

// ======================================
// WALLET CHECK
// ======================================

const walletBalance = Number(user.balance);

const purchaseAmount = Number(amount);

if (walletBalance < purchaseAmount) {

    return res.status(400).json({

        success: false,

        message: "Insufficient wallet balance"

    });

}

// ======================================
// CREATE PENDING TRANSACTION
// ======================================

const { data: pendingTx, error: pendingError }

= await supabase

.from("transactions")

.insert({

    user_id,

    request_ref: requestReference,

    phone,

    product_id,

    variation_code,

    amount: purchaseAmount,

    type: "DATA",

    status: "PENDING",

    details: "Waiting for AutoSyncNG response"

})

.select()

.single();

if (pendingError) {

    return res.status(500).json({

        success: false,

        message: "Unable to create pending transaction"

    });

}

// ======================================
// CONTINUE TO PART 3D-2C
// ======================================


        // ======================================
// CALL AUTOSYNCNG API
// ======================================

const apiResponse = await fetch(

    process.env.AUTOSYNC_BASE_URL + "/data",

    {

        method: "POST",

        headers: {

            "Content-Type": "application/json",

            "Authorization":
            `Bearer ${process.env.AUTOSYNC_API_KEY}`

        },

        body: JSON.stringify({

            request_ref: requestReference,

            phone,

            product_id,

            variation_code,

            webhook_url:
                process.env.APP_URL +
                "/api/webhook",

            ported_no: false,

            pin:
                process.env.AUTOSYNC_PIN

        })

    }

);

const result = await apiResponse.json();

// ======================================
// CHECK RESULT
// ======================================

const purchaseSuccess =

    result.status === "ok" &&

    result.data &&

    result.data.transaction &&

    result.data.transaction.status === "successful";

// ======================================
// IF FAILED
// ======================================

if (!purchaseSuccess) {

    await supabase

        .from("transactions")

        .update({

            status: "FAILED",

            details:
                result.message || "Purchase Failed",

            provider_response:
                JSON.stringify(result)

        })

        .eq("request_ref", requestReference);

    return res.status(400).json({

        success: false,

        message:
            result.message || "Purchase Failed",

        result

    });

}

// ======================================
// IF SUCCESS
// ======================================

const transaction =
    result.data.transaction;

// ======================================
// CONTINUE TO PART 3D-2D
// ======================================
    }

    catch (err) {

        console.error(err);

        return res.status(500).json({

            success: false,

            message: err.message

        });

    }

            }
