export default async function handler(req, res) {
  const sheetId = req.query.sheetId || "19z_Zx40ibDudBRrQwBJ2o2hWTyTQXPpMwCTuxsLPCrA";
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv`;

  try {
    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Falha ao acessar planilha do Google Sheets" });
    }

    const csvText = await response.text();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).send(csvText);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

