export default {
  // The index must stay visible: hiding it via the wildcard also removes
  // the top-level "Blog" navbar entry (the folder link IS its index).
  index: {
    display: 'normal',
    theme: {
      breadcrumb: false,
    },
  },
  '*': {
    display: 'hidden',
    theme: {
      breadcrumb: false,
    },
  },
};
