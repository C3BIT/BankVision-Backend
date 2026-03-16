const { DataTypes } = require('sequelize');

/**
 * Safely adds missing columns to a table based on a model definition.
 * Sequelize sync({ force: false }) only creates tables if they don't exist,
 * but doesn't add missing columns to existing tables.
 * 
 * @param {Object} sequelize - The sequelize instance
 * @param {string} modelName - The name of the model to sync
 */
const ensureColumnsExist = async (sequelize, modelName) => {
    try {
        const model = sequelize.models[modelName];
        if (!model) {
            console.warn(`⚠️ Model ${modelName} not found in sequelize instance.`);
            return;
        }

        const queryInterface = sequelize.getQueryInterface();
        const tableName = model.getTableName();

        // Get existing columns in the database
        const tableInfo = await queryInterface.describeTable(tableName);
        const existingColumns = Object.keys(tableInfo);

        // Get columns defined in the model
        const modelColumns = model.rawAttributes;

        for (const columnName in modelColumns) {
            if (!existingColumns.includes(columnName)) {
                console.log(`🔧 Column "${columnName}" is missing in table "${tableName}". Adding it...`);

                const columnDefinition = modelColumns[columnName];

                // Add the column
                await queryInterface.addColumn(tableName, columnName, {
                    type: columnDefinition.type,
                    allowNull: columnDefinition.allowNull !== false,
                    defaultValue: columnDefinition.defaultValue,
                    ...columnDefinition.dialectOptions
                });

                console.log(`✅ Column "${columnName}" added successfully to "${tableName}".`);
            }
        }
    } catch (error) {
        console.error(`❌ Error syncing columns for model ${modelName}:`, error.message);
    }
};

/**
 * Syncs columns for all critical models
 * @param {Object} sequelize - The sequelize instance
 */
const syncAllCriticalModels = async (sequelize) => {
    console.log('🔄 Starting safety schema synchronization...');

    const criticalModels = [
        'Admin',
        'Manager',
        'CallLog',
        'ChangeRequest',
        'CustomerFeedback',
        'Recording',
        'AuthenticationLog',
        'TransactionLog',
        'AdminActivityLog'
    ];

    for (const modelName of criticalModels) {
        await ensureColumnsExist(sequelize, modelName);
    }

    console.log('✅ Safety schema synchronization completed.');
};

module.exports = {
    ensureColumnsExist,
    syncAllCriticalModels
};
