async function buyData() {

    const network = document.getElementById("network").value;
    const plan = document.getElementById("plan").value;
    const phone = document.getElementById("phone").value;
    const pin = document.getElementById("transactionPin").value;

    if (!phone || phone.length != 11) {
        alert("Enter valid phone number");
        return;
    }

    if (pin.length != 4) {
        alert("Enter your 4 digit PIN");
        return;
    }

    // Load user
    const { data: user } = await client
        .from("users")
        .select("*")
        .eq("id", currentUser.id)
        .single();

    if (!user) {
        alert("User not found");
        return;
    }

    // Verify PIN
    if (user.transaction_pin !== pin) {
        alert("Incorrect Transaction PIN");
        return;
    }

    const amount = Number(plan);

    // Wallet Check
    if (Number(user.balance) < amount) {
        alert("Insufficient wallet balance");
        return;
    }

    processPurchase(network, plan, phone, amount);
}

async function processPurchase(network, plan, phone, amount){

    const response = await fetch("/api/place-order",{

        method:"POST",

        headers:{
            "Content-Type":"application/json"
        },

        body:JSON.stringify({

            network,
            plan,
            phone

        })

    });

    const result = await response.json();

    if(!result.status){

        alert(result.message);

        return;

    }

    // deduct wallet

    const newBalance = Number(currentBalance) - amount;

    await client

    .from("users")

    .update({

        balance:newBalance

    })

    .eq("id",currentUser.id);

    // save transaction

    await client

    .from("transactions")

    .insert([{

        user_id:currentUser.id,

        type:"Data Purchase",

        details:network+" "+phone,

        amount,

        status:"Success"

    }]);

    alert("Data Purchase Successful");

    location.reload();

            }
