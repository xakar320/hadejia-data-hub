async function buyAirtime() {

    const network = document.getElementById("network").value;
    const phone = document.getElementById("phone").value;
    const amount = Number(document.getElementById("amount").value);
    const pin = document.getElementById("transactionPin").value;

    if (!/^0\d{10}$/.test(phone)) {
        alert("Enter a valid phone number");
        return;
    }

    if (amount < 50) {
        alert("Minimum airtime is ₦50");
        return;
    }

    if (pin.length !== 4) {
        alert("Enter your 4-digit PIN");
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

    // Check balance
    if (Number(user.balance) < amount) {
        alert("Insufficient wallet balance");
        return;
    }

    // Send to backend
    const response = await fetch("/api/buy-airtime", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            network,
            phone,
            amount
        })
    });

    const result = await response.json();

    if (!result.status) {
        alert(result.message);
        return;
    }

    // Deduct wallet
    const newBalance = Number(user.balance) - amount;

    await client
        .from("users")
        .update({
            balance: newBalance
        })
        .eq("id", currentUser.id);

    // Save transaction
    await client
        .from("transactions")
        .insert([{
            user_id: currentUser.id,
            type: "Airtime Purchase",
            details: `${network} Airtime to ${phone}`,
            amount,
            status: "Success"
        }]);

    alert("Airtime Purchase Successful");

    location.reload();
}
