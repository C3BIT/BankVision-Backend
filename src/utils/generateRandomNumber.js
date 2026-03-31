const generateRandomNumberBySize = (size) => {
    const min = Math.pow(10, size - 1);
    const max = Math.pow(10, size) - 1;
    return Math.floor(min + Math.random() * (max - min + 1)).toString();};

module.exports = {generateRandomNumberBySize};