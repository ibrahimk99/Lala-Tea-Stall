document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.querySelector('input[name="search"]');
  const clientContainer = document.querySelector('.row');

  // Function to update client data dynamically
  const updateClients = (clients) => {
    clientContainer.innerHTML = ''; // Clear current clients
    if (clients.length > 0) {
      clients.forEach(client => {
        const clientCard = `
          <div class="col-12 col-sm-6 col-md-4 col-lg-3 mb-4">
            <div class="card card-custom">
              <div class="card-header text-white">
                <a href="/${client.tableName}" class="text-white">
                  <h5 class="card-title">${client.tableName}</h5>
                </a>
              </div>
              <div class="card-body">
                <p><strong>Last Deduction:</strong> ${client.totals?.lastDeduction || 0}</p>
                <p><strong>Deduction Date:</strong> ${client.totals?.deductionDate ? new Date(client.totals.deductionDate).toLocaleString() : 'N/A'}</p>
                <p><strong>Grand Total:</strong> ${client.totals?.grandTotal || 0}</p>
              </div>
              <div class="card-footer text-center">
                    <form action="${/edit/client.tableName}" method="get" style="display:inline;">
                        <button type="submit" class="btn btn-primary btn-sm">Edit</button>
                    </form>

                    <!-- Delete Button -->
                    <form action="${/delete/client.tableName}" method="POST" style="display:inline;"
                        onsubmit="return confirm('Are you sure you want to delete this client and all associated data?');">
                        <button type="submit" class="btn btn-danger btn-sm">Delete</button>
                    </form>
                </div>
            </div>
          </div>`;
        clientContainer.innerHTML += clientCard;
      });
    } else {
      clientContainer.innerHTML = '<p class="text-center">No clients found.</p>';
    }
  };

  // Add event listener to the search input for live search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value;
    fetch(`/clients?search=${query}`, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest' // Ensure server knows it's an AJAX request
      }
    })
      .then(response => response.json())
      .then(data => updateClients(data))
      .catch(err => console.error('Error fetching client data:', err));
  });
});

document.addEventListener("DOMContentLoaded", function() {
  const row = document.querySelector('.row');
  row.classList.add('visible'); // Add the visible class to trigger fade-in
});




var currentDate = new Date();
var dateString = currentDate.toLocaleDateString();
var timeString = currentDate.toLocaleTimeString();
document.body.innerHTML = `<html><head><title>${dateString} ${timeString}</title></head><body><h1>Printed on: ${dateString} at ${timeString}</h1> ${printContents}</body></html>`;