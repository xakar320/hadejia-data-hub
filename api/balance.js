export default async function handler(req, res) {

  try {

    const response = await fetch("https://autosyncng.com/api/user/", {
      method: "GET",
      headers: {
        Authorization: "Bearer 988|WDYTnvBrrSIlZoflQMuU8lLRotdLUInb6c989515",
        Accept: "application/json"
      }
    });

    const text = await response.text();

    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch {
      return res.status(500).json({
        status: "error",
        message: text
      });
    }

  } catch (error) {

    return res.status(500).json({
      status: "error",
      message: error.message
    });

  }

}
