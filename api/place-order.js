// api/place-order.js
import { createClient } from "@supabase/supabase-js";

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

        const {

            user_id,
            phone,
            product_id,
            variation_code,
            amount

        } = req.body;

        if (
            !user_id ||
            !phone ||
            !product_id ||
            !variation_code ||
            !amount
        ) {

            return res.status(400).json({

                success: false,
                message: "Missing parameters"

            });

        }

        //------------------------------------
        // GET USER
        //------------------------------------

        const { data: user, error: userError } =
            await supabase
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

        //------------------------------------
        // CHECK BALANCE
        //------------------------------------

        if (Number(user.balance) < Number(amount)) {

            return res.status(400).json({

                success: false,
                message: "Insufficient Balance"

            });

        }

        //------------------------------------
        // REQUEST REF
        //------------------------------------

        const request_ref =
            "HDH" + Date.now();

        //------------------------------------
        // AUTOSYNC REQUEST
        //------------------------------------

        const response =
            await fetch(
                process.env.AUTOSYNC_BASE_URL + "/data",
                {

                    method: "POST",

                    headers: {

                        Authorization:
                            "Bearer " +
                            process.env.AUTOSYNC_API_KEY,

                        "Content-Type":
                            "application/json"

                    },

                    body: JSON.stringify({

                        request_ref,

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

        const result =
            await response.json();

        //------------------------------------
        // SUCCESS
        //------------------------------------

        if (result.status === true ||
            result.success === true) {

            const newBalance =
                Number(user.balance) -
                Number(amount);

            await supabase
                .from("users")
                .update({

                    balance: newBalance

                })
                .eq("id", user_id);

            await supabase
                .from("transactions")
                .insert({

                    user_id,

                    request_ref,

                    phone,

                    product_id,

                    variation_code,

                    amount,

                    type: "DATA",

                    status: "SUCCESS",

                    provider_response:
                        JSON.stringify(result)

                });

            return res.json({

                success: true,

                message:
                    "Data Purchase Successful",

                balance:
                    newBalance,

                result

            });

        }

        //------------------------------------
        // FAILED
        //------------------------------------

        await supabase
            .from("transactions")
            .insert({

                user_id,

                request_ref,

                phone,

                product_id,

                variation_code,

                amount,

                type: "DATA",

                status: "FAILED",

                provider_response:
                    JSON.stringify(result)

            });

        return res.status(400).json({

            success: false,

            message:
                result.message ||
                "Purchase Failed"

        });

    } catch (err) {

        console.log(err);

        return res.status(500).json({

            success: false,

            message: err.message

        });

    }

}
