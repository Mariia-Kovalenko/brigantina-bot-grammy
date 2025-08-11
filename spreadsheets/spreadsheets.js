import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credentialsPath = path.join(__dirname, '..', 'credentials.json');
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

// Create a JWT client with the credentials
const { client_email, private_key } = credentials;

const serviceAccountAuth = new JWT({
  email: client_email,
  key: private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
const merchDoc = new GoogleSpreadsheet(process.env.MERCH_SHEET_ID, serviceAccountAuth);


// Function to access the spreadsheet and return competitions
export  async function getEvents() {
    try {
        await doc.loadInfo(); // Load the document's info
        const sheet = doc.sheetsByTitle["competitions"]; // Access the 'competitions' sheet
        console.log(sheet.title);
        const rows = await sheet.getRows(); // Fetch all rows
        const competitions = rows.map((row) => ({
            id: row.get("id"),
            name: row.get("Назва змагань"),
            date: row.get("Дата"),
            deadline: row.get("Дедлайн"),
            paymentInfo: row.get("Реквізити для оплати"),
            description: row.get("Вікові категорії учасників"), 
            info: row.get("Інформація"),
            full_info: row.get("Повна інформація"),
        }));

        return competitions;
    } catch (error) {
        console.error("Error fetching competitions:", error);
        return [];
    }
}

// // Function to send a list of upcoming competitions
export async function sendCompetitionsList(chatId) {
    const competitions = await getCompetitions(); // Fetch the list of competitions
    const today = new Date(); // Get the current date
    
    const upcomingCompetitions = competitions.filter((comp) => {
        const dateParts = comp.date.split("."); // Split the date string by '.'
        const competitionDate = new Date(
            `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`
        ); // Rearrange to YYYY-MM-DD

        // console.log(
        //     "competition date:",
        //     comp.date,
        //     competitionDate,
        //     "now:",
        //     today
        // );

        if (isNaN(competitionDate.getTime())) {
            console.error(
                "Invalid Date format for competition:",
                comp.name,
                comp.date
            );
            return false;
        }

        return competitionDate > today; // Include only competitions with a date later than today
    });


    if (upcomingCompetitions.length === 0) {
        bot.sendMessage(chatId, "No upcoming competitions at the moment.");
        return;
    }

    let response = "Here are the upcoming competitions:\n";
    upcomingCompetitions.forEach((comp, index) => {
        response += `${index + 1}. ${comp.name} - ${comp.date}\n${
            comp.description
        }\n\n`;
    });

    bot.sendMessage(chatId, response); // Send the response to the user
}

// Function to get a competition by its ID
export async function getCompetitionById(competitionId) {
  const competitions = await getEvents();
  return competitions.find((comp) => comp.id === competitionId);
}

// Function to save user registration to the appropriate competition sheet
export async function saveRegistration(userState) {
    try {
        console.log('Starting saveRegistration with userState:', userState);
        await doc.loadInfo();
        console.log('Document loaded successfully');

        const competition = await getCompetitionById(userState.eventId);
        console.log('Found competition:', competition);

        if (!competition) {
            throw new Error('Competition not found');
        }

        // Get the sheet by competition name
        let sheet = doc.sheetsByTitle[competition.name];
        console.log('Current sheet:', sheet ? sheet.title : 'not found');

        if (!sheet) {
            console.log('Creating new sheet for competition:', competition.name);
            sheet = await doc.addSheet({
                title: competition.name,
                headerValues: userState.steps.map(step => step.title),
            });
            console.log('New sheet created:', sheet.title);
        }

        // Prepare the row data dynamically based on steps and userState
        const rowData = {};
        userState.steps.forEach((step) => {
            // Get the safe key (with underscores)
            const safeKey = step.title.replace(/\s+/g, '_');
            // Get the value using the safe key
            const value = userState[safeKey] || '';
            // Use the original title as the key in rowData
            rowData[step.title] = value;
            console.log(`Adding data for ${step.title}: ${value}`);
        });

        // Add payment date/time to the [payment] column if it exists
        const headerValues = sheet.headerValues || (await sheet.loadHeaderRow(), sheet.headerValues);
        const paymentColumn = headerValues.find(col => col.includes('[payment]'));
        if (paymentColumn && userState.paymentDateTime) {
            rowData[paymentColumn] = userState.paymentDateTime;
            console.log(`Adding payment date/time for ${paymentColumn}: ${userState.paymentDateTime}`);
        }

        console.log('Final row data to be saved:', rowData);

        try {
            const result = await sheet.addRow(rowData);
            console.log('result', result);
            console.log('Row added successfully');
            return result;
        } catch (e) {
            console.error('Error or timeout adding row:', e);
            throw e;
        }
    } catch (error) {
        console.error('Error in saveRegistration:', error);
        throw error;
    }
}


export async function getEventColumns(event) {
  try {
      await doc.loadInfo(); // Ensure the document is loaded
      const sheet = doc.sheetsByTitle[event.name]; // Get the sheet by title
      // Load the header row explicitly
      await sheet.loadHeaderRow(); // This ensures the header row is loaded

      let columns = sheet.headerValues; // Now it should be available
      if (!columns || columns.length === 0) {
          console.warn("headerValues is empty, extracting headers manually...");
          const rows = await sheet.getRows(); // Fetch all rows
          if (rows.length > 0) {
              columns = Object.keys(rows[0]._rawData); // Extract column headers from raw data
          } else {
              throw new Error("No rows found to extract headers.");
          }
      }
      return columns || [];
  } catch (error) {
      console.error("Error getting event columns:", error);
      return [];
  }
}

export async function getAgeGroups(competitionId) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle["age_groups"];
        const rows = await sheet.getRows();
        return rows
            .filter(row => row.get("competition_id") == competitionId)
            .map(row => row.get("age_group"));
    } catch (error) {
        console.error("Error fetching age groups:", error);
        return [];
    }
}

export async function getCoaches(competitionId) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle["coaches"];
        const rows = await sheet.getRows();
        return rows
            .filter(row => row.get("competition_id") == competitionId)
            .map(row => ({
                id: row.get("coach_id"),
                name: row.get("coach_name")
            }));
    } catch (error) {
        console.error("Error fetching coaches:", error);
        return [];
    }
}

// // Function to fetch notifications from the 'notifications' sheet
// async function getNotifications() {
//     try {
//         await doc.loadInfo();
//         const sheet = doc.sheetsByTitle["notifications"];
//         if (!sheet) {
//             console.error("No 'notifications' sheet found");
//             return [];
//         }
//         const rows = await sheet.getRows();
//         return rows.map(row => ({
//             id: row.get("id"),
//             message: row.get("message"),
//             action_message: row.get("action_message"),
//             action: row.get("action"),
//             action_type: row.get("action_type"),
//             send_date_time: row.get("send_date_time"),
//         }));
//     } catch (error) {
//         console.error("Error fetching notifications:", error);
//         return [];
//     }
// }

// // Add a chatId to the 'chat_ids' sheet if not already present
// async function addChatId(chatId) {
//     try {
//         await doc.loadInfo();
//         const sheet = doc.sheetsByTitle["chat_ids"];
//         if (!sheet) {
//             console.error("No 'chat_ids' sheet found");
//             return;
//         }
//         const rows = await sheet.getRows();
//         const exists = rows.some(row => row.get("chat_id") == chatId);
//         if (!exists) {
//             await sheet.addRow({ chat_id: chatId });
//         }
//     } catch (error) {
//         console.error("Error adding chatId:", error);
//     }
// }

// // Get all chatIds from the 'chat_ids' sheet
// async function getAllChatIds() {
//     try {
//         await doc.loadInfo();
//         const sheet = doc.sheetsByTitle["chat_ids"];
//         if (!sheet) {
//             console.error("No 'chat_ids' sheet found");
//             return [];
//         }
//         const rows = await sheet.getRows();
//         return rows.map(row => row.get("chat_id"));
//     } catch (error) {
//         console.error("Error fetching chatIds:", error);
//         return [];
//     }
// }

function parseCsvToArray(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Normalize Google Drive links to direct-view URLs for Telegram
function normalizeDriveLinkToDirectView(url) {
  if (!url) return "";
  const str = String(url);
  let m = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  m = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  return str;
}

export async function getMerchProducts() {
  try {
    await merchDoc.loadInfo();
    const sheet = merchDoc.sheetsByTitle["каталог"];
    if (!sheet) {
      console.error("Не знайдено аркуш 'каталог' у таблиці мерчу");
      return [];
    }
    const rows = await sheet.getRows();
    return rows.map((row) => {
      const id = row.get("Код");
      const name = row.get("Назва");
      const category = row.get("Категорія");
      const description = row.get("Опис");
      const color = row.get("Колір");
      const price = Number(row.get("Ціна")) || 0;
      const stock = Number(row.get("В наявності")) || 0;
      const imageRaw = row.get("Зображення");
      const image = normalizeDriveLinkToDirectView(imageRaw);
      return {
        id: String(id),
        name,
        category,
        description,
        color,
        price,
        stock,
        image,
      };
    });
  } catch (error) {
    console.error("Помилка отримання мерчу:", error);
    return [];
  }
}

export async function getMerchCategories() {
  const items = await getMerchProducts();
  return Array.from(new Set(items.map((i) => i.category).filter(Boolean)));
}

export async function saveMerchOrder(order) {
  try {
    await merchDoc.loadInfo();
    let sheet = merchDoc.sheetsByTitle["замовлення"];
    if (!sheet) {
      sheet = await merchDoc.addSheet({
        title: "замовлення",
        headerValues: [
          "timestamp",
          "user_id",
          "username",
          "first_name",
          "last_name",
          "category",
          "item_id",
          "item_name",
          "color",
          "size",
          "quantity",
          "price",
          "total",
          "notes",
        ],
      });
    }

    const quantity = Number(order.quantity) || 1;
    const priceNum = Number(order.price) || 0;
    const total = quantity * priceNum;

    const rowData = {
      timestamp: new Date().toISOString(),
      user_id: order.userId || '',
      username: order.username || '',
      first_name: order.firstName || '',
      last_name: order.lastName || '',
      category: order.category || '',
      item_id: order.itemId || '',
      item_name: order.itemName || '',
      color: order.color || '',
      size: order.size || '',
      quantity,
      price: priceNum,
      total,
      notes: order.notes || '',
    };

    await sheet.addRow(rowData);
    return true;
  } catch (error) {
    console.error("Error saving merch order:", error);
    throw error;
  }
}

export async function saveMerchOrdersSimple(rows) {
  // rows: Array<{ date: string, product: string, color: string, qty: number, customer: string, phone: string }>
  try {
    await merchDoc.loadInfo();
    let sheet = merchDoc.sheetsByTitle["замовлення"];
    if (!sheet) {
      sheet = await merchDoc.addSheet({
        title: "замовлення",
        headerValues: ["Дата", "Товар", "Колір", "Кількість", "Замовник", "Телефон"],
      });
    } else {
      // Ensure header row is loaded
      try { await sheet.loadHeaderRow(); } catch {}
    }

    for (const r of rows) {
      await sheet.addRow({
        "Дата": r.date,
        "Товар": r.product,
        "Колір": r.color,
        "Кількість": r.qty,
        "Замовник": r.customer,
        "Телефон": r.phone,
      });
    }
    return true;
  } catch (error) {
    console.error("Error saving simple merch orders:", error);
    throw error;
  }
}

