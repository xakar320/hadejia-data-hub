// ==========================================
// Hadejia Data Hub
// AutoSyncNG Data Purchase API
// api/place-order.js
// ==========================================

export default async function handler(req, res) {

    if (req.method !== "POST") {

        return res.status(405).json({

            success: false,

            message: "Method Not Allowed"

        });

    }

    try {

        const {

            network,

            plan,

            phone

        } = req.body;

        // Validate input
        if (!network || !plan || !phone) {

            return res.status(400).json({

                success: false,

                message: "Missing required fields"

            });

        }

        // AutoSyncNG API URL
        const url =
        "https://autosyncng.com/api/v1/data";

        // API Request
        const response = await fetch(url, {

            method: "POST",

            headers: {

                "Content-Type": "application/json",

                "Authorization":
                `Bearer ${process.env.AUTOSYNC_API_KEY}`

            },

            body: JSON.stringify({

                network: network,

                plan: plan,

                phone: phone,

                reference:
                "HDH-" + Date.now()

            })

        });

        const result = await response.json();

        return res.status(200).json(result);

    }

    catch (err) {

        console.error(err);

        return res.status(500).json({

            success: false,

            message: err.message

        });

    }

}
