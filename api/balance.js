export default async function handler(req, res) {

    try {

        const response = await fetch(
            "https://autosyncng.com/api/user",
            {
                method: "GET",

                headers: {
                    "Authorization":
                    "Bearer 988|WDYTnvBrrSIlZoflQMuU8lLRotdLUInb6c989515",

                    "Accept":
                    "application/json"
                }
            }
        );

        const data = await response.json();

        console.log(data);

        // CHECK ALL POSSIBLE BALANCE TYPES

        let balance = null;

        if (data.balance) {

            balance = data.balance;

        }

        else if (data.wallet_balance) {

            balance = data.wallet_balance;

        }

        else if (
            data.wallet &&
            data.wallet.balance
        ) {

            balance = data.wallet.balance;

        }

        else if (
            data.data &&
            data.data.balance
        ) {

            balance = data.data.balance;

        }

        if (balance !== null) {

            res.status(200).json({
                balance: balance
            });

        } else {

            res.status(200).json({
                balance: 0,
                raw: data
            });

        }

    } catch (error) {

        res.status(500).json({
            status: "error",
            message: error.message
        });

    }

}
