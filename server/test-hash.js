const bcrypt = require('bcryptjs');
console.log('Match?', bcrypt.compareSync('password123', '$2a$12$LJ3m4ys2Y5pR8X0Yn7rKzOzHMVqGtFnRqZCGpKPg0FqF8YYxJxGaS'));
console.log('New Hash:', bcrypt.hashSync('password123', 12));
