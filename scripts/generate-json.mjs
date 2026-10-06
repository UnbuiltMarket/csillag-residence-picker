import fs from "node:fs/promises";

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_APARTMENTS_TABLE_ID,
  AIRTABLE_ROOMS_TABLE_ID,
} = process.env;

if (!AIRTABLE_TOKEN) {
  throw new Error("AIRTABLE_TOKEN is missing.");
}

if (!AIRTABLE_BASE_ID) {
  throw new Error("AIRTABLE_BASE_ID is missing.");
}

if (!AIRTABLE_APARTMENTS_TABLE_ID) {
  throw new Error("AIRTABLE_APARTMENTS_TABLE_ID is missing.");
}

if (!AIRTABLE_ROOMS_TABLE_ID) {
  throw new Error("AIRTABLE_ROOMS_TABLE_ID is missing.");
}

async function fetchAllRecords(tableId, sortField) {
  const records = [];
  let offset;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`
    );

    if (sortField) {
      url.searchParams.set("sort[0][field]", sortField);
      url.searchParams.set("sort[0][direction]", "asc");
    }

    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Airtable request failed (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

function formatArea(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  if (Number.isNaN(number)) {
    return null;
  }

  if (Number.isInteger(number)) {
    return `${number} m²`;
  }

  // Keep two decimals so values like 2.9 become "2,90 m²" (matches production JSON)
  return `${number.toFixed(2).replace(".", ",")} m²`;
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  if (Number.isNaN(number)) {
    return null;
  }

  const grouped = Math.round(number)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  return `${grouped} Ft`;
}

function formatParkingPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  if (Number.isNaN(number)) {
    return null;
  }

  // Match production JSON: narrow no-break spaces between groups and before Ft
  const grouped = Math.round(number)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

  return `${grouped}\u00a0Ft`;
}

function formatRoomArea(value) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return "0 m²";
  }

  if (Number.isInteger(number)) {
    return `${number} m²`;
  }

  return `${number.toFixed(2).replace(".", ",")} m²`;
}

function emptyToNull(value) {
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

function linkedOrTextApartmentId(fields) {
  if (typeof fields["Apartment ID"] === "string" && fields["Apartment ID"]) {
    return fields["Apartment ID"];
  }

  // Fallback if Airtable returns linked record names via a lookup field
  const lookup = fields["Apartment ID (from Apartment)"];
  if (Array.isArray(lookup) && lookup[0]) {
    return String(lookup[0]);
  }

  return "";
}

const apartmentRecords = await fetchAllRecords(
  AIRTABLE_APARTMENTS_TABLE_ID,
  "Apartment ID"
);
const roomRecords = await fetchAllRecords(AIRTABLE_ROOMS_TABLE_ID);

const roomsByApartmentId = new Map();

for (const record of roomRecords) {
  const fields = record.fields;
  const apartmentId = linkedOrTextApartmentId(fields);

  if (!apartmentId) {
    continue;
  }

  if (!roomsByApartmentId.has(apartmentId)) {
    roomsByApartmentId.set(apartmentId, []);
  }

  roomsByApartmentId.get(apartmentId).push({
    name: fields["Room Name"] ?? "",
    area: formatRoomArea(fields["Area m2"]),
    x: Number(fields["Label X"] ?? 0),
    y: Number(fields["Label Y"] ?? 0),
    sortOrder: Number(fields["Sort Order"] ?? 0),
  });
}

for (const rooms of roomsByApartmentId.values()) {
  rooms.sort((a, b) => a.sortOrder - b.sortOrder);
}

const apartments = apartmentRecords
  .map((record) => {
    const fields = record.fields;
    const id = fields["Apartment ID"] ?? "";

    if (!id) {
      return null;
    }

    const roomList = (roomsByApartmentId.get(id) || []).map(
      ({ name, area, x, y }) => ({ name, area, x, y })
    );

    const areaInteriorNum = Number(fields["Area Interior m2"] ?? 0);
    const areaTerraceNum = Number(fields["Area Terrace m2"] ?? 0);
    const areaGardenRaw = emptyToNull(fields["Area Garden m2"]);
    const areaGardenNum =
      areaGardenRaw === null ? null : Number(areaGardenRaw);
    const priceRaw = emptyToNull(fields["Price HUF"]);
    const parkingPriceRaw = emptyToNull(fields["Parking Price HUF"]);

    return {
      id,
      name: fields["Name"] ?? "",
      building: fields["Building"] ?? "",
      floor: Number(fields["Floor"] ?? 0),
      hrsz: fields["HRSZ"] ?? "",
      status: fields["Status"] ?? "",
      maskColor: fields["Mask Color"] ?? "",
      areaInteriorNum,
      areaTerraceNum,
      areaGardenNum,
      areaInterior: formatArea(areaInteriorNum),
      areaTerrace: formatArea(areaTerraceNum),
      areaGarden: formatArea(areaGardenNum),
      price: priceRaw === null ? null : Number(priceRaw),
      priceFormatted: formatPrice(priceRaw),
      floorplan: fields["Floorplan URL"] ?? "",
      layoutLabel: null,
      roomList,
      areaTotal: Number(fields["Area Total m2"] ?? areaInteriorNum),
      storage: Boolean(fields["Has Storage"]),
      parking: emptyToNull(fields["Parking"]),
      parkingPrice:
        parkingPriceRaw === null ? null : Number(parkingPriceRaw),
      parkingPriceFormatted: formatParkingPrice(parkingPriceRaw),
    };
  })
  .filter(Boolean);

apartments.sort((a, b) =>
  String(a.id).localeCompare(String(b.id), "hu", { numeric: true })
);

await fs.writeFile(
  "./apartments.json",
  JSON.stringify(apartments, null, 2) + "\n",
  "utf8"
);

console.log(
  `Generated apartments.json with ${apartments.length} apartments and ${
    apartments.reduce((sum, apartment) => sum + apartment.roomList.length, 0)
  } rooms.`
);
