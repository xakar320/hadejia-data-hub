export default async function handler(req, res) {

  try {

    const response = await fetch("https://autosyncng.com/api/user", {

      method: "GET",

      headers: {
        Authorization: "Bearer 988|WDYTnvBrrSIlZoflQMuU8lLRotdLUInb6c989515",
        Accept: "application/json"
      }

    });

    const data = await response.json();

    res.status(200).json(data);

  } catch (error) {

    res.status(500).json({
      status: "error",
      message: error.message
    });

  }

}
