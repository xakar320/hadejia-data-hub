export default async function handler(req, res) {

    try {

        const response = await fetch(
            "https://autosyncng.com/api/user", {

            method: "GET",

            headers: {
                Authorization: "Bearer 988|WDYTnvBrrSIlZoflQMuU8lLRotdLUInb6c989515",
                Accept: "application/json"
            }

        });

        const data = await response.json();

        // idan balance yana cikin wallet
        if (data.wallet && data.wallet.balance) {

            res.status(200).json({
                balance: data.wallet.balance
            });

        }

        // idan balance yana direct
        else if (data.balance) {

            res.status(200).json({
                balance: data.balance
            });

        }

        else {

            res.status(200).json({
                balance: 0
            });

        }

    } catch (error) {

        res.status(500).json({
            status: "error",
            message: error.message
        });

    }

}
