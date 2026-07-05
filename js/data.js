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
