const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const ejsMate = require('ejs-mate')
const port = 3000;
const axios = require('axios');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');

// pCloud API credentials
const P_CLOUD_ACCESS_TOKEN = 'YOUR_P_CLOUD_ACCESS_TOKEN';

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  database: 'shop',
  password: 'Zoom1234',});
db.connect((err) => {
  if (err) { throw err; }
  console.log('MySQL Connected...');
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.engine('ejs', ejsMate); 

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tea.png'))});

app.get('/create', (req, res) => {
  res.render('createClient');
});

app.post('/create', (req, res) => {
  const { clientId } = req.body;
  if (!clientId || !/^[a-zA-Z 0-9_]+$/.test(clientId)) {
    return res.status(400).send('Invalid client ID');
  }
  const tableName = `${clientId.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}_shop`;
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS \`${tableName}\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      quantity INT,
      bottle INT,
      tea INT,
      kharcha INT,
      grand_total_copy INT,
      deduction INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

  const createDeductionLedger = `
  CREATE TABLE IF NOT EXISTS deduction_ledger (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(255),
    deduction_amount INT,
    grand_total_before_deduction INT,
    grand_total_copy INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`;
  db.query(createDeductionLedger, (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Failed to create deduction ledger table');
    }
    db.query(createTableQuery, (err, result) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).send('Failed to create client table');
      }
      console.log(`Table ${tableName} created successfully.`);
      res.redirect('/create')
    });
  });
});

app.get('/edit/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.render('edit.ejs', { clientId });
});

app.post('/edit/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { newClientId } = req.body;
  if (!clientId || !/^[a-zA-Z 0-9_]+$/.test(clientId)) {
    return res.status(400).send('Invalid new client ID');
  }
  const oldTableName = `${clientId}_shop`;
  const newTableName = `${newClientId}_shop`;
  try {
    await db.promise().query(`RENAME TABLE \`${oldTableName}\` TO \`${newTableName}\``);
    res.redirect('/clients');
  } catch (err) {
    res.status(500).send('Failed to rename client table');
  }
});

app.get('/clients', (req, res) => {
  let {clientId} = req.params;
  const tableName = `${clientId}_shop`;
  const searchQuery = req.query.search || '';
  const likeSearchQuery = `%${searchQuery}%`;

  const getTablesSql = 
    `SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'shop' 
    AND table_name LIKE '%_shop' 
    AND table_name LIKE ?;`;
  db.query(getTablesSql, [likeSearchQuery], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Failed to retrieve clients');
    }
    const tables = results.map(row => row.TABLE_NAME);
    const promises = tables.map(tableName => {
      return new Promise((resolve, reject) => {
        const sumQuery = `SELECT 
          (SELECT deduction FROM \`${tableName}\` ORDER BY id DESC LIMIT 1) AS lastDeduction,
          (SELECT created_at FROM deduction_ledger WHERE client_id = ? ORDER BY created_at DESC LIMIT 1) AS deductionDate,
          (SELECT grand_total_copy FROM \`${tableName}\` ORDER BY id DESC LIMIT 1) AS grandTotal
          FROM \`${tableName}\` LIMIT 1;`;
        db.query(sumQuery, [tableName.replace('_shop', '')], (err, results) => {
          if (err) {
            return reject(err);
          }
          resolve({
            tableName: tableName.replace('_shop', ''),
            totals: results[0]
          });
        });
      });
    });
    Promise.all(promises)
      .then(data => {
        if (req.xhr) {
          res.json(data);
        } else {
          res.render('allClientsnew', { tableName, clients: data, searchQuery: searchQuery });
        }
      })
      .catch(err => {
        console.error('Error retrieving data:', err);
        res.status(500).send('Failed to retrieve client data');
      });
  });
});

app.get('/daily-deductions', (req, res) => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS daily_reports (
        report_date DATE NOT NULL,
        client_id VARCHAR(255)  NOT NULL,
        total_deductions DECIMAL(10, 2) NOT NULL,
        transaction_count INT NOT NULL,
        remaining_total DECIMAL(10, 2) NOT NULL,
        PRIMARY KEY (report_date, client_id)
    )`;
  db.query(createTableQuery, (err) => {
    if (err) {
      console.error('Error creating table:', err);
      return res.status(500).send('Failed to create table');
    }

    const insertDailyReportQuery = `
      INSERT INTO daily_reports (report_date, client_id, total_deductions, transaction_count, remaining_total)
      SELECT CURDATE() AS report_date, client_id, 
             SUM(deduction_amount) AS total_deductions, 
             COUNT(*) AS transaction_count, 
             IFNULL(MAX(grand_total_copy), 0)  AS remaining_total
      FROM deduction_ledger
      WHERE DATE(created_at) = CURDATE()
      GROUP BY client_id
      ON DUPLICATE KEY UPDATE 
          total_deductions = VALUES(total_deductions), 
          transaction_count = VALUES(transaction_count),
          remaining_total = VALUES(remaining_total)`;
    db.query(insertDailyReportQuery, (err) => {
      if (err) {
        console.error('Error saving daily report:', err);
        return res.status(500).send('Failed to save daily report');
      }

      const previousReportsQuery = `
        SELECT report_date, client_id, total_deductions, transaction_count, remaining_total
        FROM daily_reports
        ORDER BY report_date DESC, client_id ASC`;
      db.query(previousReportsQuery, (err, previousReports) => {
        if (err) {
          console.error('Error retrieving previous reports:', err);
          return res.status(500).send('Failed to retrieve previous reports');
        }

        const grandTotalQuery = `
          SELECT DATE(created_at) AS date, 
                 SUM(deduction_amount) AS grand_total
          FROM deduction_ledger
          GROUP BY DATE(created_at)
          ORDER BY date DESC`;
        db.query(grandTotalQuery, (err, grandTotalResults) => {
          if (err) {
            console.error('Error retrieving grand totals:', err);
            return res.status(500).send('Failed to retrieve grand totals');
          }

          const grandTotalMap = grandTotalResults.reduce((map, item) => {
            map[new Date(item.date).toLocaleDateString('en-PK')] = Number(item.grand_total);
            return map;
          }, {});

          const deductionProgressQuery = `
          SELECT client_id, DATE(created_at) AS date,
                 SUM(deduction_amount) AS total_deductions, 
                 COUNT(*) AS transaction_count, 
                 IFNULL(MAX(grand_total_before_deduction), 0) - IFNULL(SUM(deduction_amount), 0) AS remaining_total
          FROM deduction_ledger
          WHERE DATE(created_at) = CURDATE()
          GROUP BY client_id, DATE(created_at)`;
          db.query(deductionProgressQuery, (err, deductionProgress) => {
            if (err) {
              console.error('Error retrieving deduction progress:', err);
              return res.status(500).send('Failed to retrieve deduction progress');
            }

            const processedDeductionProgress = deductionProgress.map(item => ({
              ...item,
              total_deductions: item.total_deductions || 0,
              remaining_total: item.remaining_total || 0
            }));

            res.render('DPR', {
              progress: processedDeductionProgress,
              grandTotalMap,
              previousReports
            });
          });
        });
      });
    });
  });
});

app.get('/grand-totals', (req, res) => {
  const getTablesSql = `SELECT table_name
    FROM information_schema.tables 
    WHERE table_schema = 'shop' 
    AND table_name LIKE '%_shop';`;
  db.query(getTablesSql, (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Failed to retrieve clients');
    }
    const tables = results.map(row => row.TABLE_NAME);
    const promises = tables.map(tableName => {
      return new Promise((resolve, reject) => {
        const sumQuery = `SELECT 
          (SELECT grand_total_copy FROM \`${tableName}\` 
          ORDER BY id DESC LIMIT 1) AS grandTotal
          FROM \`${tableName}\` LIMIT 1;`;
        db.query(sumQuery, (err, results) => {
          if (err) {
            return reject(err);
          }
          resolve({
            tableName: tableName.replace('_shop', ''),
            grandTotal: Number(results[0]?.grandTotal) || 0
          });
        });
      });
    });
    Promise.all(promises)
      .then(data => {
        const totalSum = data.reduce((sum, client) => sum + parseFloat(client.grandTotal || 0), 0);
        res.render('grandTotals', { clients: data, totalSum });
      })
      .catch(err => {
        console.error('Error retrieving data:', err);
        res.status(500).send('Failed to retrieve client data');
      });
  });
});

//  pCloud Data Backup Route
app.get('/:clientId/backup', (req, res) => {
  const { clientId } = req.params;
  const tableName = `${clientId}_shop`;

  // Fetch client data from the SQL database
  const query = `SELECT * FROM \`${tableName}\``;
  db.query(query, (err, results) => {
    if (err) {
      console.error('Database error during data backup:', err);
      return res.status(500).send('Database error during data backup.');
    }

    // CSV file path and name
    const fileName = `${clientId}_backup.csv`;
    const filePath = path.join(__dirname, fileName);

    // CSV writer configuration
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: Object.keys(results[0]).map((key) => ({ id: key, title: key }))
    });

    // Write SQL results to CSV
    csvWriter.writeRecords(results)
      .then(() => {
        console.log('CSV file created successfully.');

        // Upload the file to pCloud
        const uploadUrl = `https://api.pcloud.com/uploadfile?access_token=${P_CLOUD_ACCESS_TOKEN}&folderid=0&filename=${fileName}`;
        const formData = {
          file: fs.createReadStream(filePath)
        };

        axios.post(uploadUrl, formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        .then(response => {
          console.log('Backup successful:', response.data);
          res.render('backupSuccess', { clientId });

          // Clean up the local CSV file after upload
          fs.unlink(filePath, () => {});
        })
        .catch(err => {
          console.error('Error uploading to pCloud:', err);
          res.status(500).send('Error uploading backup to pCloud.');
        });
      })
      .catch(err => {
        console.error('Error writing CSV file:', err);
        res.status(500).send('Error creating CSV backup file.');
      });
  });
});



app.get('/:clientId', (req, res) => {
  const { clientId } = req.params;
  const bottleOptions = [
    {  value: 0, text: '' },
    { value: 60, text: 'Regular Bottle' },
    { value: 70, text: 'Sting' },
    { value: 170, text: 'Litre' },
    { value: 210, text: '1.5 Litre' },
    { value: 230, text: '2 Litre' },
    { value: 120, text: '1/2 Litre' },
    { value: 130, text: 'Fresher Juice' }
  ];
  const teaOptions = [
    {  value: 0, text: '' },
    { value: 60, text: 'Regular Tea' },
    { value: 40, text: 'Token Tea' }
  ];
  const tableName = `${clientId}_shop`;
  const detailsPage = Math.max(parseInt(req.query.detailsPage) || 1, 1);
  const ledgerPage = Math.max(parseInt(req.query.ledgerPage) || 1, 1);
  const limit = 10;
  const detailsOffset = (detailsPage - 1) * limit;
  const ledgerOffset = (ledgerPage - 1) * limit;

  const detailsQuery = `
    SELECT *, 
      (SELECT grand_total_copy FROM \`${tableName}\` ORDER BY id DESC LIMIT 1) AS remaining_total, 
      (SELECT deduction FROM \`${tableName}\` ORDER BY id DESC LIMIT 1) AS total_deduction 
      FROM \`${tableName}\`
      ORDER BY id DESC
      LIMIT ?, ?;`;
  const ledgerQuery = `
    SELECT * 
    FROM deduction_ledger 
    WHERE client_id = ? 
    ORDER BY created_at DESC
    LIMIT ?, ?;`;
  const detailsCountQuery = `SELECT COUNT(*) AS count FROM \`${tableName}\`;`;
  const ledgerCountQuery = `SELECT COUNT(*) AS count FROM deduction_ledger WHERE client_id = ?;`;

  db.query(detailsQuery, [detailsOffset, limit], (err, detailsResults) => {
    if (err) {
      console.error('Database error during details retrieval:', err);
      return res.status(500).send('Database error during details retrieval');
    }
    db.query(detailsCountQuery, (err, detailsCountResult) => {
      if (err) {
        console.error('Database error during details count retrieval:', err);
        return res.status(500).send('Database error during details count retrieval');
      }
      const totalDetailsPages = Math.ceil(detailsCountResult[0].count / limit);
      db.query(ledgerQuery, [clientId, ledgerOffset, limit], (err, ledgerResults) => {
        if (err) {
          console.error('Database error during ledger retrieval:', err);
          return res.status(500).send('Database error during ledger retrieval');
        }
        db.query(ledgerCountQuery, [clientId], (err, ledgerCountResult) => {
          if (err) {
            console.error('Database error during ledger count retrieval:', err);
            return res.status(500).send('Database error during ledger count retrieval');
          }
          const totalLedgerPages = Math.ceil(ledgerCountResult[0].count / limit);

          res.render('clientCombined', {
            clientId,
            bottleOptions,
            teaOptions,
            tableName: clientId,
            details: detailsResults,
            ledger: ledgerResults,
            currentDetailsPage: detailsPage,
            totalDetailsPages,
            currentLedgerPage: ledgerPage,
            totalLedgerPages
          });
        });
      });
    });
  });
});

app.post('/submit/:clientId', (req, res) => {
  const { clientId } = req.params;
  const { bottleValue, teaValue, quantity, kharcha } = req.body;

  const parsedQuantity = parseFloat(quantity);
  const parsedBottleValue = bottleValue ? parseFloat(bottleValue) : null;
  const parsedTeaValue = teaValue ? parseFloat(teaValue) : null;
  const parsedKharchaValue = parseFloat(kharcha) || 0;

  if (isNaN(parsedQuantity) || isNaN(parsedKharchaValue)) {
    return res.status(400).send('Invalid input values.');
  }

  const selectedBottleValue = parsedBottleValue !== null ? parsedBottleValue * parsedQuantity : null;
  const selectedTeaValue = parsedTeaValue !== null ? parsedTeaValue * parsedQuantity : null;
  const kharchaValue = parsedKharchaValue;
  const tableName = `${clientId}_shop`;

  const getLastTotalQuery = `
    SELECT grand_total_copy 
    FROM \`${tableName}\` 
    ORDER BY id DESC 
    LIMIT 1;`;
  db.query(getLastTotalQuery, (err, results) => {
    if (err) {
      console.error('Database error during last total retrieval:', err);
      return res.status(500).send('Database error during total retrieval');
    }
    const lastTotal = results.length > 0 ? parseFloat(results[0].grand_total_copy) : 0;
    const newGrandTotal = lastTotal + (selectedBottleValue || 0) + (selectedTeaValue || 0) + kharchaValue;

    const insertQuery = `
      INSERT INTO \`${tableName}\` 
      (quantity, bottle, tea, kharcha, grand_total_copy, deduction)
      VALUES (?, ?, ?, ?, ?, 0);`;
    db.query(insertQuery, [
      parsedQuantity,
      selectedBottleValue,
      selectedTeaValue,
      kharchaValue,
      newGrandTotal
    ], (err) => {
      if (err) {
        console.error('Database error during data insertion:', err);
        return res.status(500).send('Database error during data insertion');
      }
      console.log('Data saved successfully.');
      res.redirect(`/${clientId}`);
    });
  });
});

app.post('/deduct/:clientId', (req, res) => {
  const { clientId } = req.params;
  const { deductionAmount } = req.body;
  const deductionValue = parseFloat(deductionAmount);
  const tableName = `${clientId}_shop`;

  const getLastTotalQuery = `
    SELECT grand_total_copy 
    FROM \`${tableName}\` 
    ORDER BY id DESC 
    LIMIT 1;`;
  db.query(getLastTotalQuery, (err, results) => {
    if (err) {
      console.error('Database error during last total retrieval:', err);
      return res.status(500).send('Database error during total retrieval');
    }
    const lastTotal = results.length > 0 ? parseFloat(results[0].grand_total_copy) : 0;
    const newGrandTotal = lastTotal - deductionValue;

    const updateDeductionQuery = `UPDATE \`${tableName}\` 
      SET deduction = deduction + ?, 
      grand_total_copy = ?
      ORDER BY id DESC 
      LIMIT 1;`;
    const insertLedgerQuery = `
    INSERT INTO deduction_ledger (client_id, deduction_amount, grand_total_before_deduction, grand_total_copy) 
    VALUES (?, ?, ?, ?);`;
 
    db.beginTransaction((err) => {
      if (err) throw err;
      db.query(updateDeductionQuery, [deductionValue, newGrandTotal], (err) => {
        if (err) {
          return db.rollback(() => {
            console.error('Database error:', err);
            res.status(500).send('Failed to deduct amount');
          });
        }
        db.query(insertLedgerQuery, [clientId, deductionValue, lastTotal, newGrandTotal], (err) => {
          if (err) {
            return db.rollback(() => {
              console.error('Database error:', err);
              res.status(500).send('Failed to record deduction');
            });
          }
          db.commit((err) => {
            if (err) {
              return db.rollback(() => {
                console.error('Database error:', err);
                res.status(500).send('Failed to commit transaction');
              });
            }
            res.redirect(`/${clientId}`);
          });
        });
      });
    });
  });
});

app.get('/update-tables', (req, res) => {
  const getTablesSql = `SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'shop' 
    AND table_name LIKE '%_shop';`;
  db.query(getTablesSql, (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Failed to retrieve client tables');
    }
    const tables = results.map(row => row.TABLE_NAME);
    const alterPromises = tables.map(tableName => {
      const alterTableQuery = `ALTER TABLE \`${tableName}\`
        ADD COLUMN grand_total_copy DECIMAL(10, 2) DEFAULT 0, 
        ADD COLUMN deduction DECIMAL(10, 2) DEFAULT 0;`;
      return new Promise((resolve, reject) => {
        db.query(alterTableQuery, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(`Table ${tableName} altered successfully.`);
        });
      });
    });
    Promise.all(alterPromises)
      .then(messages => {
        messages.forEach(msg => console.log(msg));
        res.send('All tables updated successfully.');
      })
      .catch(err => {
        console.error('Error updating tables:', err);
        res.status(500).send('Failed to update some client tables');
      });
  });
});


app.post('/delete/:tableName', (req, res) => {
  const { tableName } = req.params;
  const tableNameWithPrefix = `${tableName}_shop`;
  const dropTableQuery = `DROP TABLE IF EXISTS \`${tableNameWithPrefix}\``;
  db.query(dropTableQuery, (err, result) => {
    if (err) {
      console.error('Error deleting client table:', err);
      return res.status(500).send('Error deleting client table');
    }
    res.redirect('/clients');
  });
});

app.post('/delete/client/:tableName/:id', (req, res) => {
  const { tableName, id } = req.params;
  const tableNameWithPrefix = `${tableName}_shop`;
  const deleteQuery = `DELETE FROM \`${tableNameWithPrefix}\` WHERE id = ?`;
  db.query(deleteQuery, [id], (err, result) => {
    if (err) {
      console.error('Error deleting client detail row:', err);
      return res.status(500).send('Error deleting client detail row');
    }

    const recalculateTotalQuery = `
      UPDATE \`${tableNameWithPrefix}\` AS t1
      JOIN (
        SELECT id, 
        SUM(bottle + tea + kharcha) 
        OVER (ORDER BY id) AS running_total
        FROM \`${tableNameWithPrefix}\`
      ) AS t2 ON t1.id = t2.id
      SET t1.grand_total_copy = t2.running_total;`;
    db.query(recalculateTotalQuery, (err) => {
      if (err) {
        console.error('Error recalculating grand total:', err);
        return res.status(500).send('Error recalculating grand total');
      }
      res.redirect(`/${tableName}`);
    });
  });
});

app.post('/delete/ledger/:tableName/:id', (req, res) => {
  const { tableName, id } = req.params;
  const tableNameWithPrefix = `${tableName}_shop`;

  const getDeductionQuery = `
    SELECT deduction_amount, grand_total_before_deduction 
    FROM deduction_ledger 
    WHERE id = ?`;
  db.query(getDeductionQuery, [id], (err, results) => {
    if (err || results.length === 0) {
      console.error('Error retrieving deduction details:', err);
      return res.status(500).send('Error retrieving deduction details');
    }
    const { deduction_amount } = results[0];

    const deleteLedgerQuery = `DELETE FROM deduction_ledger WHERE id = ?`;
    db.query(deleteLedgerQuery, [id], (err) => {
      if (err) {
        console.error('Error deleting ledger entry:', err);
        return res.status(500).send('Error deleting ledger entry');
      }

      const getLatestIdQuery = `SELECT id FROM \`${tableNameWithPrefix}\` ORDER BY id DESC LIMIT 1`;
      db.query(getLatestIdQuery, (err, latestRowResults) => {
        if (err || latestRowResults.length === 0) {
          console.error('Error retrieving latest row id:', err);
          return res.status(500).send('Error retrieving latest row id');
        }
        const latestId = latestRowResults[0].id;

        const updateClientDetailsQuery = `
          UPDATE \`${tableNameWithPrefix}\`
          SET grand_total_copy = grand_total_copy + ?, 
          deduction = deduction - ?
          WHERE id = ?`;
        db.query(updateClientDetailsQuery, [deduction_amount, deduction_amount, latestId], (err) => {
          if (err) {
            console.error('Error updating client details:', err);
            return res.status(500).send('Error updating client details');
          }
          res.redirect(`/${tableName}`);
        });
      });
    });
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});