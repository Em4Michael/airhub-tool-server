const router = require('express').Router();
const { protect } = require('../middleware/auth');
const User = require('../models/User');

router.use(protect);

// GET /api/users/profile
router.get('/profile', (req, res) => {
  res.json({ success: true, data: req.user });
});

// PATCH /api/users/profile
router.patch('/profile', async (req, res, next) => {
  try {
    const { phone, bankAccount } = req.body;
    const update = {};
    if (phone !== undefined) update.phone = phone;
    if (bankAccount !== undefined) update.bankAccount = bankAccount;

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true });
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
