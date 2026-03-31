const bcrypt = require('bcryptjs');
const sequelize = require('../configs/sequelize');
const { Admin } = require('../models/Admin');

const seedAdmin = async () => {
  try {
    await sequelize.sync();
    console.log('Database connected');

    // Sync Admin model
    await Admin.sync();
    console.log('Admin table synced');

    // Check if admin exists
    const existingAdmin = await Admin.findOne({
      where: { email: 'admin@vbrm.com' }
    });

    if (existingAdmin) {
      console.log('Admin already exists:', existingAdmin.email);
      return;
    }

    // Create default admin
    const hashedPassword = await bcrypt.hash('admin123', 10);

    const admin = await Admin.create({
      name: 'Super Admin',
      email: 'admin@vbrm.com',
      password: hashedPassword,
      role: 'super_admin',
      isActive: true
    });

    console.log('Admin created successfully!');
    console.log('Email:', admin.email);
    console.log('Password: admin123');
    console.log('Role:', admin.role);

  } catch (error) {
    console.error('Error seeding admin:', error);
  } finally {
    process.exit(0);
  }
};

seedAdmin();
