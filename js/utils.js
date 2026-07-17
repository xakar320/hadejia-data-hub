// ======================================
// Hadejia Data Hub
// utils.js
// ======================================

async function saveTransaction({

    user_id,

    type,

    details,

    amount,

    status = "Success"

}) {

    try {

        const { error } = await client

        .from("transactions")

        .insert([{

            user_id,

            type,

            details,

            amount,

            status

        }]);

        if (error) throw error;

        return true;

    }

    catch (err) {

        console.error(err);

        return false;

    }

}
